import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserTurn, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import * as realLauncherBrowserHost from "../src/launcher-browser-host";

// Snapshot the real launcher host exports before any module mock is installed, so the mock can
// delegate everything it does not override and be restored for subsequent test files.
const realLauncherHostExports = { ...realLauncherBrowserHost };

// Shared probe state the mocked notifyLauncherTurn records into.
const launcherProbe = {
  leasePending: false,
  heartbeatsWhileLeasePending: 0,
  endStatuses: [] as string[],
};

mock.module("../src/launcher-browser-host", () => ({
  ...realLauncherHostExports,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS: 20,
  notifyLauncherTurn: async (
    _descriptorPath: string,
    activity: { phase: string; traceId: string; status?: string },
  ) => {
    if (activity.phase === "start") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { surfaceId: "b".repeat(32), reused: false, connectorBound: false, trackUsage: false };
    }
    if (activity.phase === "heartbeat") {
      if (launcherProbe.leasePending) launcherProbe.heartbeatsWhileLeasePending += 1;
      return {};
    }
    launcherProbe.endStatuses.push(activity.status ?? "");
    return { cancelledByUser: false };
  },
}));

afterAll(() => {
  mock.module("../src/launcher-browser-host", () => ({ ...realLauncherHostExports }));
  mock.restore();
});

function baseBrowserTurn(traceId: string, overrides: Partial<BrowserTurn> = {}): BrowserTurn {
  return {
    traceId,
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
    ...overrides,
  } as BrowserTurn;
}

function diagnosticsTempRoot(): string {
  return join(mkdtempSync(join(tmpdir(), "browser-worker-defects-")), "diagnostics");
}

test("run rejects an invalid trace id before preparing the prompt", async () => {
  const prepareCalls: string[] = [];
  const runExclusiveCalls: string[] = [];
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    runExclusive: async (turn: { traceId: string }) => {
      runExclusiveCalls.push(turn.traceId);
      return turn.traceId;
    },
  }) as unknown as ChatGptBrowserWorker;
  const turn = baseBrowserTurn("bad id!", {
    prepare: async () => {
      prepareCalls.push("bad id!");
      return { text: "hello", images: [], release() {} };
    },
  });

  await expect(worker.run(turn)).rejects.toThrow(/trace id is invalid/i);
  expect(runExclusiveCalls).toEqual([]);
  expect(prepareCalls).toEqual([]);
});

test("a prompt prepared before staging fails still gets released", async () => {
  let released = 0;
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: {
      browserHost: "managed-chrome",
      appName: "test",
      browserDiagnosticsPath: diagnosticsTempRoot(),
    },
  }) as unknown as ChatGptBrowserWorker;
  const turn = baseBrowserTurn("bad id!", {
    prepare: async () => ({
      text: "hello",
      images: [],
      release: () => {
        released += 1;
      },
    }),
  });

  const runBrowserTurn = (
    worker as unknown as { runBrowserTurn(turn: BrowserTurn): Promise<string> }
  ).runBrowserTurn.bind(worker);
  await expect(runBrowserTurn(turn)).rejects.toThrow(/trace id is invalid/i);
  expect(released).toBe(1);
});

test("worker close cleans up browser state even when the launcher helper refuses to terminate", async () => {
  const consoleErrors: unknown[][] = [];
  const consoleErrorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args);
  });
  try {
    const browserCloses: number[] = [];
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      launcherHelper: {
        close: async () => {
          throw new Error("refused termination");
        },
      },
      activeRuns: new Map(),
      maintenanceTail: Promise.resolve(),
      browser: {
        close: async () => {
          browserCloses.push(1);
        },
      },
      context: { marker: true },
      page: { marker: true },
      managedBrowserReady: Promise.resolve({ browser: {}, context: {} }),
      contextPressureByConversation: new Map([["conv-key", {}]]),
    }) as unknown as ChatGptBrowserWorker;

    await worker.close();

    const field = (name: string) => (worker as unknown as Record<string, unknown>)[name];
    expect(browserCloses).toHaveLength(1);
    expect(field("browser")).toBeUndefined();
    expect(field("context")).toBeUndefined();
    expect(field("page")).toBeUndefined();
    expect(field("managedBrowserReady")).toBeUndefined();
    expect((field("contextPressureByConversation") as Map<string, unknown>).size).toBe(0);
    expect(field("launcherHelper")).toBeUndefined();
    expect(
      consoleErrors.some((args) => args.some((arg) => typeof arg === "string" && arg.includes("refused termination"))),
    ).toBeTrue();
  } finally {
    consoleErrorSpy.mockRestore();
  }
});

test("launcher turn heartbeats while a slow onSurfaceLeased callback is still pending", async () => {
  const previousHelperEnv = process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
  process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = "1";
  try {
    launcherProbe.leasePending = true;
    launcherProbe.heartbeatsWhileLeasePending = 0;
    launcherProbe.endStatuses = [];
    let releaseLease!: () => void;
    const leaseGate = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    setTimeout(() => releaseLease(), 80);

    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {
        browserHost: "launcher",
        browserHostDescriptorPath: "/tmp/browser-worker-defects-descriptor.json",
      },
      activeRuns: new Map(),
      runBrowserTurn: async () => "ok",
    }) as unknown as ChatGptBrowserWorker;
    const turn = baseBrowserTurn("b2_heartbeat_probe", {
      onSurfaceLeased: async () => {
        await leaseGate;
      },
    });

    await expect(worker.run(turn)).resolves.toBe("ok");
    launcherProbe.leasePending = false;

    expect(launcherProbe.heartbeatsWhileLeasePending).toBeGreaterThanOrEqual(1);
    expect(launcherProbe.endStatuses).toEqual(["completed"]);
  } finally {
    if (previousHelperEnv === undefined) {
      delete process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS;
    } else {
      process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS = previousHelperEnv;
    }
  }
});
