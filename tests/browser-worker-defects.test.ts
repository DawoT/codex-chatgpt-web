import { expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserTurn, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

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
