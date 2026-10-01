import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { BrowserTurn, ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import * as realLauncherBrowserHost from "../src/launcher-browser-host";
import { makeWorkerFixture } from "./fixtures/worker-harness";

// Snapshot the real launcher host exports before any module mock is installed, so the mock can
// delegate everything it does not override and be restored for subsequent test files.
const realLauncherHostExports = { ...realLauncherBrowserHost };

// The worker dispatches through the in-process runExclusive path only when this guard is set;
// without it a launcher-hosted worker spawns the out-of-process helper client instead.
const HELPER_PROCESS_ENV = "CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS";

type LauncherTurnStartPayload = {
  phase: string;
  traceId: string;
  helperPid: number;
  conversationKey?: string;
  connectorIdentity?: string;
  requireRetainedConversation?: boolean;
  compaction?: boolean;
};

// Shared probe state the mocked notifyLauncherTurn records into.
const launcherProbe = {
  startPayloads: [] as LauncherTurnStartPayload[],
  reused: false,
};

mock.module("../src/launcher-browser-host", () => ({
  ...realLauncherHostExports,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS: 20,
  notifyLauncherTurn: async (_descriptorPath: string, activity: LauncherTurnStartPayload & { status?: string }) => {
    if (activity.phase === "start") {
      launcherProbe.startPayloads.push(activity);
      return { surfaceId: "c".repeat(32), reused: launcherProbe.reused, connectorBound: false, trackUsage: false };
    }
    if (activity.phase === "heartbeat") return {};
    return { cancelledByUser: false };
  },
}));

beforeAll(() => {
  process.env[HELPER_PROCESS_ENV] = "1";
});

afterAll(() => {
  delete process.env[HELPER_PROCESS_ENV];
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

function launcherWorkerFixture() {
  return Object.assign(makeWorkerFixture(), {
    config: {
      browserHost: "launcher",
      browserHostDescriptorPath: "owned-descriptor",
      appName: "Codex Native",
    },
    activeRuns: new Map(),
    runBrowserTurn: async () => "ok",
  }) as unknown as ChatGptBrowserWorker;
}

async function leaseStartPayload(traceId: string, overrides: Partial<BrowserTurn> = {}) {
  launcherProbe.startPayloads = [];
  const worker = launcherWorkerFixture();
  await worker.run(baseBrowserTurn(traceId, overrides));
  expect(launcherProbe.startPayloads).toHaveLength(1);
  return launcherProbe.startPayloads[0];
}

test("a Luna turn with a selected native connector advertises the connector identity in its lease", async () => {
  const payload = await leaseStartPayload("lease_native_connector", {
    conversationKey: "conv-key",
    nativeConnector: true,
  });
  expect(payload).toMatchObject({
    phase: "start",
    traceId: "lease_native_connector",
    helperPid: process.pid,
    conversationKey: "conv-key",
    connectorIdentity: "Codex Native",
  });
});

test("a tool-capable turn advertises the connector identity in its lease", async () => {
  const payload = await leaseStartPayload("lease_local_tools", {
    conversationKey: "conv-key",
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  });
  expect(payload.connectorIdentity).toBe("Codex Native");
});

test("a turn requiring a retained conversation advertises the connector identity and the requirement", async () => {
  launcherProbe.reused = true;
  try {
    const payload = await leaseStartPayload("lease_retained_required", {
      conversationKey: "conv-key",
      requireRetainedConversation: true,
      prepareResume: async () => ({ text: "resume", images: [], release() {} }),
    });
    expect(payload.connectorIdentity).toBe("Codex Native");
    expect(payload.requireRetainedConversation).toBe(true);
  } finally {
    launcherProbe.reused = false;
  }
});

test("a conversation-bound Luna turn without any connector need never advertises connector identity alone", async () => {
  const payload = await leaseStartPayload("lease_plain_luna", {
    conversationKey: "conv-key",
  });
  expect(payload.conversationKey).toBe("conv-key");
  expect("connectorIdentity" in payload).toBeFalse();
});

test("a turn without a conversation key never advertises connector identity, even with a native connector", async () => {
  const payload = await leaseStartPayload("lease_no_conversation", {
    nativeConnector: true,
  });
  expect("conversationKey" in payload).toBeFalse();
  expect("connectorIdentity" in payload).toBeFalse();
});
