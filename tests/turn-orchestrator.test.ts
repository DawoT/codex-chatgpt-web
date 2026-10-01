import { expect, spyOn, test } from "bun:test";
import { ChatGptCompactionHandoffAccepted, ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { TurnOrchestrator, type TurnOrchestratorDeps } from "../src/adapters/chatgpt-web/browser/turn-orchestrator";
import { InteractiveBrowserTurnMutex } from "../src/adapters/chatgpt-web/browser-mutex";
import type { LauncherTurnActivity } from "../src/launcher-browser/types";
import {
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
} from "../src/launcher-browser-host";
import { makeLauncherTurn } from "./fixtures/worker-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<TurnOrchestratorDeps> = {}) {
  const activities: LauncherTurnActivity[] = [];
  const mutex = new InteractiveBrowserTurnMutex();
  const deps: TurnOrchestratorDeps = {
    config: { browserHost: "launcher", browserHostDescriptorPath: "descriptor", appName: "Codex Native" },
    notifyLauncherTurn: async (path, activity) => {
      expect(path).toBe("descriptor");
      activities.push(activity);
      return activity.phase === "start" ? { surfaceId: "surface", reused: false } : {};
    },
    acquireInteractive: (trace, signal) => mutex.acquire(trace, signal),
    runBrowserTurn: async (_turn, _surface, _page, _reuse, _track, settled, acquire) => {
      await acquire?.();
      settled?.();
      return "answer";
    },
    heartbeatIntervalMs: 5,
    heartbeatTimeoutMs: 100,
    ...overrides,
  };
  return { orchestrator: new TurnOrchestrator(deps), activities, mutex };
}

test("managed turns serialize interactive input and persist the answer without a launcher lease", async () => {
  const saved: string[] = [];
  const h = harness({ config: { browserHost: "managed-chrome", appName: "Codex Native" } });
  expect(
    await h.orchestrator.run(
      makeLauncherTurn("managed", {
        onResultReady: (answer) => {
          saved.push(answer);
        },
      }),
    ),
  ).toBe("answer");
  expect(saved).toEqual(["answer"]);
  expect(h.activities).toEqual([]);
  expect(h.mutex.isLocked()).toBe(false);
});

test("abort before leasing cannot prepare, acquire input or notify the host", async () => {
  const abort = new AbortController();
  abort.abort();
  const h = harness();
  await expect(h.orchestrator.run(makeLauncherTurn("aborted", { abortSignal: abort.signal }))).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(h.activities).toEqual([]);
  expect(h.mutex.isLocked()).toBe(false);
});

test("the lease, selected prompt, result persistence and surface release retain their order", async () => {
  const order: string[] = [];
  const h = harness({
    runBrowserTurn: async (_turn, surface, _page, reused, track) => {
      expect([surface, reused, track]).toEqual(["surface", false, false]);
      order.push("run");
      return "answer";
    },
  });
  const turn = makeLauncherTurn("ordered", {
    onSurfaceLeased: (surface) => {
      order.push(`lease:${surface}`);
    },
    onPreparedSelected: (reused) => {
      order.push(`prepare:${reused}`);
    },
    onResultReady: (answer) => {
      order.push(`persist:${answer}`);
    },
    onSurfaceReleased: (surface) => {
      order.push(`release:${surface}`);
    },
  });
  expect(await h.orchestrator.run(turn)).toBe("answer");
  expect(order).toEqual(["lease:surface", "prepare:false", "run", "persist:answer", "release:surface"]);
  expect(h.activities.at(-1)).toMatchObject({ phase: "end", status: "completed", resultPersisted: true });
});

test("retained connector leases select the resume prompt and preserve the claimed surface", async () => {
  const released: string[] = [];
  const activities: LauncherTurnActivity[] = [];
  const h = harness({
    notifyLauncherTurn: async (_path, activity) => {
      activities.push(activity);
      return activity.phase === "start" ? { surfaceId: "surface", reused: true, trackUsage: true } : {};
    },
    runBrowserTurn: async (_turn, surface, _page, reused, track) => {
      expect([surface, reused, track]).toEqual(["surface", true, true]);
      return "answer";
    },
  });
  await h.orchestrator.run(
    makeLauncherTurn("retained", {
      conversationKey: "conversation",
      requireRetainedConversation: true,
      retainConversation: true,
      nativeConnector: true,
      compaction: true,
      prepareResume: async () => ({ text: "continue", images: [], release() {} }),
      onSurfaceReleased: (surface) => {
        released.push(surface);
      },
    }),
  );
  expect(activities[0]).toMatchObject({
    phase: "start",
    connectorIdentity: "Codex Native",
    conversationKey: "conversation",
    requireRetainedConversation: true,
    compaction: true,
  });
  expect(activities.at(-1)).toMatchObject({ status: "completed", retain: true, connectorBound: true });
  expect(released).toEqual([]);
});

test.each([
  ["missing surface", {}, {}, /did not lease/],
  [
    "required retention lost",
    { surfaceId: "surface", reused: false },
    { requireRetainedConversation: true },
    /retained|conversation/i,
  ],
  ["reuse lacks resume", { surfaceId: "surface", reused: true }, {}, /continuation prompt/],
] as const)("invalid lease: %s", async (_name, lease, fields, message) => {
  const activities: LauncherTurnActivity[] = [];
  const h = harness({
    notifyLauncherTurn: async (_path, activity) => {
      activities.push(activity);
      return activity.phase === "start" ? lease : {};
    },
  });
  await expect(h.orchestrator.run(makeLauncherTurn("invalid", fields))).rejects.toThrow(message);
  expect(activities.filter((activity) => activity.phase === "end")).toHaveLength("surfaceId" in lease ? 1 : 0);
});

test.each([
  [new LauncherBrowserTurnCancelledError("cancelled"), "client_cancelled"],
  [new LauncherRetainedConversationUnavailableError("gone"), "compaction_source_unavailable"],
] as const)("lease errors map to adapter errors: %s", async (failure, code) => {
  const h = harness({
    notifyLauncherTurn: async () => {
      throw failure;
    },
  });
  await expect(h.orchestrator.run(makeLauncherTurn("lease_error"))).rejects.toMatchObject({ code });
});

test.each([
  [new Error("browser failed"), "failed"],
  [new DOMException("aborted", "AbortError"), "aborted"],
  [
    new ChatGptWebAdapterError("cancelled", {
      code: "client_cancelled",
      status: 499,
      errorType: "server_error",
      retryable: false,
    }),
    "aborted",
  ],
  [new ChatGptCompactionHandoffAccepted(), "completed"],
] as const)("browser termination retains status and releases input: %s", async (failure, status) => {
  const h = harness({
    runBrowserTurn: async (_turn, _surface, _page, _reuse, _track, _settled, acquire) => {
      await acquire?.();
      await acquire?.();
      throw failure;
    },
  });
  await expect(h.orchestrator.run(makeLauncherTurn("browser_error"))).rejects.toBe(failure);
  expect(h.activities.at(-1)).toMatchObject({ phase: "end", status });
  expect(h.mutex.isLocked()).toBe(false);
});

test("a failed surface owner callback ends its lease without reporting the surface claimed", async () => {
  const released: string[] = [];
  const h = harness();
  await expect(
    h.orchestrator.run(
      makeLauncherTurn("owner_failed", {
        onSurfaceLeased: () => {
          throw new Error("owner unavailable");
        },
        onSurfaceReleased: (surface) => {
          released.push(surface);
        },
      }),
    ),
  ).rejects.toThrow("owner unavailable");
  expect(h.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(released).toEqual([]);
});

test("a result persistence error marks the turn failed and cannot claim resultPersisted", async () => {
  const h = harness();
  await expect(
    h.orchestrator.run(
      makeLauncherTurn("persist_failed", {
        onResultReady: () => {
          throw new Error("disk full");
        },
      }),
    ),
  ).rejects.toThrow("disk full");
  expect(h.activities.at(-1)).toMatchObject({ phase: "end", status: "failed" });
  expect(h.activities.at(-1)).not.toHaveProperty("resultPersisted");
});

test.each([false, true])(
  "turn-end failure preserves browser error unless the user cancelled (%s)",
  async (cancelled) => {
    const original = new Error("browser failed");
    const log = spyOn(console, "error").mockImplementation(() => {});
    const h = harness({
      notifyLauncherTurn: async (_path, activity) => {
        if (activity.phase === "start") return { surfaceId: "surface" };
        if (cancelled) return { cancelledByUser: true };
        throw new Error("host unavailable");
      },
      runBrowserTurn: async () => {
        throw original;
      },
    });
    try {
      const outcome = h.orchestrator.run(makeLauncherTurn("end_failed"));
      if (cancelled) await expect(outcome).rejects.toMatchObject({ code: "client_cancelled" });
      else await expect(outcome).rejects.toBe(original);
    } finally {
      log.mockRestore();
    }
  },
);

test("turn-end failure after success is visible to the caller", async () => {
  const h = harness({
    notifyLauncherTurn: async (_path, activity) => {
      if (activity.phase === "start") return { surfaceId: "surface" };
      throw new Error("host unavailable");
    },
  });
  await expect(h.orchestrator.run(makeLauncherTurn("end_failed_success"))).rejects.toThrow("host unavailable");
});

test("heartbeat starts before slow callbacks, does not overlap and stops at turn end", async () => {
  const enteredHeartbeat = deferred<void>();
  const finishHeartbeat = deferred<void>();
  const finishOwner = deferred<void>();
  let heartbeats = 0;
  const h = harness({
    notifyLauncherTurn: async (_path, activity, timeout, signal) => {
      if (activity.phase === "start") return { surfaceId: "surface" };
      if (activity.phase === "heartbeat") {
        expect(timeout).toBe(100);
        expect(signal).toBeUndefined();
        heartbeats += 1;
        enteredHeartbeat.resolve();
        await finishHeartbeat.promise;
      }
      return {};
    },
  });
  const running = h.orchestrator.run(makeLauncherTurn("heartbeat", { onSurfaceLeased: () => finishOwner.promise }));
  await enteredHeartbeat.promise;
  await Bun.sleep(20);
  expect(heartbeats).toBe(1);
  finishOwner.resolve();
  await running;
  finishHeartbeat.resolve();
  await Bun.sleep(20);
  expect(heartbeats).toBe(1);
});

test("heartbeat failures are throttled while the turn can still succeed", async () => {
  const failed = deferred<void>();
  const finishOwner = deferred<void>();
  let failures = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const h = harness({
    notifyLauncherTurn: async (_path, activity) => {
      if (activity.phase === "start") return { surfaceId: "surface" };
      if (activity.phase === "heartbeat") {
        failures += 1;
        if (failures === 2) failed.resolve();
        throw new Error("offline");
      }
      return {};
    },
  });
  try {
    const running = h.orchestrator.run(
      makeLauncherTurn("heartbeat_failed", { onSurfaceLeased: () => finishOwner.promise }),
    );
    await failed.promise;
    finishOwner.resolve();
    expect(await running).toBe("answer");
    expect(warn.mock.calls).toHaveLength(1);
  } finally {
    finishOwner.resolve();
    warn.mockRestore();
  }
});

test("concurrent turns share input ownership while their passive response observation overlaps", async () => {
  const firstAcquired = deferred<void>();
  const releaseFirstInput = deferred<void>();
  const finishFirstObservation = deferred<void>();
  const order: string[] = [];
  const h = harness({
    runBrowserTurn: async (turn, _surface, _page, _reuse, _track, settled, acquire) => {
      await acquire?.();
      order.push(`input:${turn.traceId}`);
      if (turn.traceId === "first") {
        firstAcquired.resolve();
        await releaseFirstInput.promise;
      }
      settled?.();
      order.push(`observe:${turn.traceId}`);
      if (turn.traceId === "first") await finishFirstObservation.promise;
      return turn.traceId;
    },
  });
  const first = h.orchestrator.run(makeLauncherTurn("first"));
  await firstAcquired.promise;
  const second = h.orchestrator.run(makeLauncherTurn("second"));
  await Bun.sleep(0);
  expect(h.mutex.waitingCount()).toBe(1);
  expect(order).toEqual(["input:first"]);
  releaseFirstInput.resolve();
  expect(await second).toBe("second");
  expect(order).toEqual(["input:first", "observe:first", "input:second", "observe:second"]);
  finishFirstObservation.resolve();
  expect(await first).toBe("first");
  expect(h.mutex.isLocked()).toBe(false);
});
