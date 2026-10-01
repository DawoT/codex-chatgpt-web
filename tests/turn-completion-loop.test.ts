import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserContextPressure } from "../src/adapters/chatgpt-web/browser/context-pressure";
import {
  absentResponseDomSnapshot,
  ChatGptCompletionTracker,
  type ChatGptResponseDomSnapshot,
} from "../src/adapters/chatgpt-web/browser/dom-trackers";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser/suspension-clock";
import {
  type TurnCompletionInput,
  TurnCompletionLoop,
  type TurnCompletionLoopDeps,
} from "../src/adapters/chatgpt-web/browser/turn-completion-loop";
import type { ChatGptTurnEvent } from "../src/adapters/chatgpt-web/browser/turn-events";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";
import { resolveTurnLivenessSignals } from "../src/adapters/chatgpt-web/browser/turn-liveness";
import type { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { fakeLocator, fakePage } from "./fixtures/browser-fakes";
import { makeLauncherTurn, makeWorkerFixture } from "./fixtures/worker-harness";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function completionHarness(overrides: Partial<TurnCompletionLoopDeps> = {}, fields: Partial<TurnCompletionInput> = {}) {
  const checkpoints: string[] = [];
  const deltas: string[] = [];
  const input: TurnCompletionInput = {
    turn: makeLauncherTurn("unit_completion", {
      onTextDelta: (delta) => {
        deltas.push(delta);
      },
    }),
    page: fakePage(),
    submissionBaseline: {
      userTurns: fakeLocator(),
      responseTurns: fakeLocator(),
      initialTurnIdentities: [],
      domCache: {},
    },
    responseTurn: { identity: "assistant", locator: fakeLocator(), acceptedTurnIdentities: [] },
    launcherSurfaceId: "surface",
    localTools: false,
    completionTracker: new ChatGptCompletionTracker(0),
    contextPressure: new ChatGptBrowserContextPressure(),
    diagnostics: {
      capture: async (_page, checkpoint) => {
        checkpoints.push(checkpoint);
      },
    },
    turnEvents: new ChatGptTurnEventBus({ turnId: "unit_completion" }),
    ...fields,
  };
  const deps: TurnCompletionLoopDeps = {
    config: { appName: "Codex Native", autoApproveToolCalls: true },
    classifyLiveness: resolveTurnLivenessSignals,
    responseDomSnapshot: async () => responseSnapshot(),
    reconcileAssistantTurnBinding: async (_page, _baseline, current) => current,
    waitForTurnDomRevisionOrExternalProgress: async () => "document:1",
    stalledTurnDiagnostic: async () => "{}",
    rebindLauncherPage: async () => input.page,
    ...overrides,
  };
  return { loop: new TurnCompletionLoop(deps), input, checkpoints, deltas };
}

test("the extracted loop streams exactly the visible answer and publishes completion evidence", async () => {
  const h = completionHarness();
  const result = await h.loop.run(h.input);
  expect(result.text).toBe("Done");
  expect(h.deltas.join("")).toBe("Done");
  expect(h.checkpoints).toEqual(["response-visible"]);
  expect(h.input.turnEvents.exportHistory().at(-1)).toMatchObject({ type: "phase_changed", to: "completed" });
});

test.each(["page closed", "aborted", "deadline", "stopped thinking"])("completion terminates on %s", async (reason) => {
  const controller = new AbortController();
  if (reason === "aborted") controller.abort();
  const h = completionHarness(
    {
      responseDomSnapshot: async () => ({
        ...responseSnapshot(),
        stoppedThinkingVisible: reason === "stopped thinking",
      }),
    },
    {
      page: fakePage({ isClosed: () => reason === "page closed" }),
      turn: makeLauncherTurn("terminal", { abortSignal: controller.signal }),
      deadline: reason === "deadline" ? 0 : undefined,
    },
  );
  await expect(h.loop.run(h.input)).rejects.toThrow();
  expect(h.deltas).toEqual([]);
  expect(
    h.input.turnEvents.exportHistory().some((event) => event.type === "phase_changed" && event.to === "completed"),
  ).toBe(false);
});

test("an observation timeout on an open managed page waits and recovers without requesting a lease", async () => {
  let reads = 0;
  let rebinds = 0;
  const h = completionHarness(
    {
      responseDomSnapshot: async () => {
        reads += 1;
        if (reads === 1) throw new ChatGptBrowserObservationTimeoutError(1);
        return responseSnapshot();
      },
      rebindLauncherPage: async () => {
        rebinds += 1;
        return fakePage();
      },
    },
    { launcherSurfaceId: undefined },
  );
  expect((await h.loop.run(h.input)).text).toBe("Done");
  expect(rebinds).toBe(0);
  expect(reads).toBe(3);
});

test("stalled launcher observation switches to the recovered page and rebinds the same assistant", async () => {
  const recoveredPage = fakePage();
  let reads = 0;
  const observedPages: Page[] = [];
  const h = completionHarness({
    responseDomSnapshot: async () => {
      reads += 1;
      if (reads === 1) throw new ChatGptBrowserObservationTimeoutError(1);
      return responseSnapshot();
    },
    rebindLauncherPage: async (attempt, failure) => {
      expect(attempt).toBe(1);
      expect(failure).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
      return recoveredPage;
    },
    waitForTurnDomRevisionOrExternalProgress: async (page) => {
      observedPages.push(page);
      return "recovered:1";
    },
  });
  expect((await h.loop.run(h.input)).text).toBe("Done");
  expect(observedPages).toEqual([recoveredPage]);
  expect(h.checkpoints).toContain("response-page-rebound");
});

test("recovery transport failure reports the actual cause without starting a fresh conversation", async () => {
  const recoveryError = new Error("CDP unavailable");
  const h = completionHarness({
    responseDomSnapshot: async () => {
      throw new ChatGptBrowserObservationTimeoutError(1);
    },
    rebindLauncherPage: async () => {
      throw recoveryError;
    },
  });
  await expect(h.loop.run(h.input)).rejects.toMatchObject({
    code: "chatgpt_browser_dom_unresponsive",
    cause: recoveryError,
  });
});

test("continued observation timeouts exhaust the same-page rebind budget", async () => {
  let attempts = 0;
  const h = completionHarness({
    responseDomSnapshot: async () => {
      throw new ChatGptBrowserObservationTimeoutError(1);
    },
    rebindLauncherPage: async () => {
      attempts += 1;
      return fakePage();
    },
  });
  await expect(h.loop.run(h.input)).rejects.toMatchObject({ code: "chatgpt_browser_dom_unresponsive" });
  expect(attempts).toBe(2);
});

test("a missing assistant binding reconciles against its original submission baseline", async () => {
  let reads = 0;
  const replacement = fakeLocator();
  const h = completionHarness(
    {
      responseDomSnapshot: async (locator) => {
        reads += 1;
        if (reads === 1) return absentResponseDomSnapshot();
        expect(locator).toBe(replacement);
        return responseSnapshot();
      },
      reconcileAssistantTurnBinding: async (_page, baseline, current) => {
        expect(baseline.initialTurnIdentities).toEqual(["previous-assistant"]);
        expect(current.identity).toBe("missing");
        return { ...current, identity: "replacement", locator: replacement };
      },
    },
    {
      responseTurn: { identity: "missing", locator: fakeLocator({ count: async () => 0 }), acceptedTurnIdentities: [] },
      submissionBaseline: {
        userTurns: fakeLocator(),
        responseTurns: fakeLocator(),
        initialTurnIdentities: ["previous-assistant"],
        domCache: {},
      },
    },
  );
  expect((await h.loop.run(h.input)).text).toBe("Done");
  expect(reads).toBe(3);
});

test("current tool activity postpones a missing DOM verdict until a visible answer returns", async () => {
  let reads = 0;
  const progress = new ChatGptExternalTurnProgress();
  progress.recordClaim();
  const h = completionHarness(
    {
      responseDomSnapshot: async () => {
        reads += 1;
        if (reads === 1) return absentResponseDomSnapshot();
        return responseSnapshot();
      },
      waitForTurnDomRevisionOrExternalProgress: async () => {
        return "document:2";
      },
    },
    { turn: makeLauncherTurn("live", { externalProgress: progress }) },
  );
  expect((await h.loop.run(h.input)).text).toBe("Done");
  expect(reads).toBe(3);
});

test("a completed tool batch requires an answer beyond the projection acknowledged before execution", async () => {
  const progress = new ChatGptExternalTurnProgress();
  const revision = progress.recordToolBatch(1);
  let reads = 0;
  const h = completionHarness(
    {
      responseDomSnapshot: async () => {
        reads += 1;
        const text = reads === 1 ? "Before tool" : "After tool";
        return {
          ...responseSnapshot(),
          visibleText: text,
          fullHtml: `<p>${text}</p>`,
          markdownSegments: [{ key: "answer", text, html: `<p>${text}</p>`, streamable: true }],
        };
      },
      waitForTurnDomRevisionOrExternalProgress: async () => {
        await progress.waitForToolBatchObservation(revision);
        if (progress.snapshot().activeToolCalls > 0) progress.recordToolResult();
        return `document:${reads}`;
      },
    },
    { turn: makeLauncherTurn("tool_projection", { externalProgress: progress }) },
  );
  expect((await h.loop.run(h.input)).text).toBe("After tool");
  expect(progress.snapshot().activeToolCalls).toBe(0);
  expect(h.input.turnEvents.exportHistory().some((event) => event.type === "external_progress_advanced")).toBe(true);
});

test("a repeatable internal DOM TypeError exhausts its bounded retry budget", async () => {
  let reads = 0;
  const h = completionHarness({
    responseDomSnapshot: async () => {
      reads += 1;
      throw new TypeError("DOM projection unavailable");
    },
  });
  await expect(h.loop.run(h.input)).rejects.toThrow("9 times in a row");
  expect(reads).toBe(9);
  expect(h.checkpoints).toHaveLength(8);
  expect(h.deltas).toEqual([]);
});

test("completed Luna responses remove the private checkpoint before streaming to the caller", async () => {
  const text = `Answer\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\nKeep working on the refactor.`;
  const snapshot: ChatGptResponseDomSnapshot = {
    ...responseSnapshot(),
    visibleText: text,
    fullHtml: `<p>${text}</p>`,
    markdownSegments: [{ key: "p", text, html: `<p>${text}</p>`, streamable: true }],
  };
  const captured: string[] = [];
  const deltas: string[] = [];
  const h = completionHarness(
    { responseDomSnapshot: async () => snapshot },
    {
      turn: makeLauncherTurn("checkpoint", {
        captureLunaCheckpoint: true,
        onLunaCheckpoint: (checkpoint) => {
          if (checkpoint.checkpoint.version === 2) captured.push(checkpoint.checkpoint.summary);
        },
        onTextDelta: (delta) => {
          deltas.push(delta);
        },
      }),
    },
  );
  expect((await h.loop.run(h.input)).text).toBe("Answer");
  expect(deltas.join("")).toBe("Answer");
  expect(captured).toEqual(["Keep working on the refactor."]);
});

function chainLocator(): Record<string, unknown> {
  const locator: Record<string, unknown> = {
    filter: () => locator,
    last: () => locator,
    getByTestId: () => chainLocator(),
    getByText: () => chainLocator(),
    getByRole: () => chainLocator(),
    isVisible: async () => false,
    count: async () => 1,
    press: async () => {},
    evaluate: async () => undefined,
  };
  return locator;
}

function responseSnapshot() {
  return {
    responsePresent: true,
    visibleText: "Done",
    fullHtml: "<p>Done</p>",
    markdownSegments: [{ key: "p-0", html: "<p>Done</p>", text: "Done", streamable: true }],
    completionActionVisible: true,
    stoppedThinkingVisible: false,
    traceBlocks: [],
  };
}

async function driveCompletion(options: {
  traceId: string;
  fenced: boolean;
  begin?: () => Promise<number | undefined>;
  commit?: () => Promise<boolean>;
  onTextDelta?: (text: string) => void;
}) {
  const diagnostics = mkdtempSync(join(tmpdir(), "completion-loop-"));
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    evaluate: async () => ({}),
    isClosed: () => false,
    mainFrame: () => frame,
    locator: () => chainLocator(),
    getByRole: () => chainLocator(),
  }) as unknown as Page;
  const actions: string[] = [];
  let snapshotCount = 0;
  const progress = new ChatGptExternalTurnProgress();
  try {
    const worker = Object.assign(makeWorkerFixture(), {
      config: {
        appName: "Codex Native2",
        browserDiagnosticsPath: diagnostics,
        browserHostDescriptorPath: "owned-descriptor",
      },
      contextPressureByConversation: new Map(),
      contextPressureByPage: new WeakMap(),
      runStage: async (
        _trace: string,
        _name: string,
        _timeout: number,
        action: (signal: AbortSignal) => Promise<unknown>,
      ) => action(new AbortController().signal),
      prepareChatSurface: async () => chainLocator(),
      selectModelAndEffort: async () => resolveChatGptWebModelMode("gpt-5.6-sol", "high", capabilities as never),
      captureSubmissionBaseline: async () => ({}),
      attachPrompt: async () => {},
      attachFiles: async () => {},
      sendAttachedPrompt: async (...args: unknown[]) => {
        const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
        await lifecycle.onSendActivated();
        lifecycle.onSubmitted?.();
        return "user_turn";
      },
      waitForNewAssistantTurn: async () => ({
        identity: "assistant-1",
        locator: chainLocator(),
        acceptedTurnIdentities: [],
      }),
      responseDomSnapshot: async () => {
        snapshotCount += 1;
        return responseSnapshot();
      },
      waitForTurnDomRevisionOrExternalProgress: async () => {
        actions.push("wake");
        // The completion tracker requires a signature stable for its settle window; the wake is
        // what separates two observations of the same stable answer.
        if (snapshotCount === 1) await new Promise((resolve) => setTimeout(resolve, 2_100));
        return "document:0";
      },
      stalledTurnDiagnostic: async () => "{}",
    }) as Record<string, any> & { runBrowserTurn: ChatGptBrowserWorker["runBrowserTurn"] };
    const text = await worker.runBrowserTurn(
      {
        traceId: options.traceId,
        modelId: "gpt-5.6-sol",
        modelFamily: "5.6",
        reasoning: "high",
        capabilities: capabilities as never,
        onTextDelta: options.onTextDelta ?? (() => {}),
        ...(options.fenced ? { externalProgress: progress } : {}),
        completionFence: options.fenced
          ? {
              begin: async () => {
                actions.push("begin");
                return options.begin ? await options.begin() : 7;
              },
              commit: async () => {
                actions.push("commit");
                return options.commit ? await options.commit() : true;
              },
            }
          : undefined,
        prepare: async () => ({ text: "Say done", images: [], release: () => {} }),
      },
      "owned-surface",
      page,
    );
    const history = worker.turnEventBuses?.get(options.traceId)?.exportHistory() ?? [];
    return {
      text,
      actions,
      snapshotCount,
      allEvents: history,
      phaseTrail: history.filter((event: ChatGptTurnEvent) => event.type === "phase_changed"),
    };
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
}

test("an unfenced completion streams phases and finishes through the event-driven wake", async () => {
  const result = await driveCompletion({ traceId: "completion_unfenced", fenced: false });
  expect(result.text).toBe("Done");
  expect(result.actions).toEqual(["wake"]);
  expect(result.phaseTrail.map((event: ChatGptTurnEvent) => (event as { to: string }).to)).toEqual([
    "streaming",
    "completed",
  ]);
  expect(result.allEvents.some((event: ChatGptTurnEvent) => event.type === "completion_action_changed")).toBe(true);
  expect(result.allEvents.some((event: ChatGptTurnEvent) => event.type === "stop_button_visibility_changed")).toBe(
    true,
  );
}, 15_000);

test("a fenced completion walks begin → fresh read → commit with a wake between fence steps", async () => {
  const result = await driveCompletion({ traceId: "completion_fenced", fenced: true });
  expect(result.text).toBe("Done");
  expect(result.actions).toEqual(["wake", "begin", "wake", "commit"]);
  expect(result.phaseTrail.map((event: ChatGptTurnEvent) => (event as { to: string }).to)).toEqual([
    "streaming",
    "settling",
    "completed",
  ]);
}, 15_000);

test("a fence begin the broker cannot grant is retried after a wake, not a fixed sleep", async () => {
  let begins = 0;
  const result = await driveCompletion({
    traceId: "completion_begin_retry",
    fenced: true,
    begin: async () => {
      begins += 1;
      return begins === 1 ? undefined : 7;
    },
  });
  expect(result.text).toBe("Done");
  expect(result.actions).toEqual(["wake", "begin", "wake", "begin", "wake", "commit"]);
}, 15_000);

test("a rejected terminal commit restarts the fence and observes again before committing", async () => {
  let commits = 0;
  const result = await driveCompletion({
    traceId: "completion_commit_retry",
    fenced: true,
    commit: async () => {
      commits += 1;
      return commits > 1;
    },
  });
  expect(result.text).toBe("Done");
  expect(result.actions).toEqual(["wake", "begin", "wake", "commit", "wake", "begin", "wake", "commit"]);
}, 15_000);

test("a consumer TypeError after a successful DOM read fails immediately without replaying a delta", async () => {
  const consumerError = new TypeError("text sink closed");
  let deltas = 0;
  await expect(
    driveCompletion({
      traceId: "completion_consumer_failed",
      fenced: false,
      onTextDelta: () => {
        deltas += 1;
        throw consumerError;
      },
    }),
  ).rejects.toBe(consumerError);
  expect(deltas).toBe(1);
}, 15_000);

test("compaction handoff publishes compaction_handoff_observed to the turn event bus", async () => {
  const diagnostics = mkdtempSync(join(tmpdir(), "completion-handoff-"));
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    evaluate: async () => ({}),
    isClosed: () => false,
    mainFrame: () => frame,
    locator: () => chainLocator(),
    getByRole: () => chainLocator(),
  }) as unknown as Page;

  const abortController = new AbortController();

  try {
    const worker = Object.assign(makeWorkerFixture(), {
      config: {
        appName: "Codex Native2",
        browserDiagnosticsPath: diagnostics,
        browserHostDescriptorPath: "owned-descriptor",
      },
      contextPressureByConversation: new Map(),
      contextPressureByPage: new WeakMap(),
      runStage: async (
        _trace: string,
        _name: string,
        _timeout: number,
        action: (signal: AbortSignal) => Promise<unknown>,
      ) => action(abortController.signal),
      prepareChatSurface: async () => chainLocator(),
      selectModelAndEffort: async () => resolveChatGptWebModelMode("gpt-5.6-sol", "high", capabilities as never),
      captureSubmissionBaseline: async () => ({}),
      attachPrompt: async () => {},
      attachFiles: async () => {},
      sendAttachedPrompt: async (...args: unknown[]) => {
        const lifecycle = args[5] as { onSendActivated(): Promise<void>; onSubmitted?: () => void };
        await lifecycle.onSendActivated();
        lifecycle.onSubmitted?.();
        return "user_turn";
      },
      waitForNewAssistantTurn: async () => {
        abortController.abort(new ChatGptCompactionHandoffAccepted());
        throw new DOMException("The operation was aborted", "AbortError");
      },
    }) as Record<string, any> & { runBrowserTurn: ChatGptBrowserWorker["runBrowserTurn"] };

    await expect(
      worker.runBrowserTurn(
        {
          traceId: "completion_compaction_handoff",
          modelId: "gpt-5.6-sol",
          modelFamily: "5.6",
          reasoning: "high",
          capabilities: capabilities as never,
          abortSignal: abortController.signal,
          onTextDelta: () => {},
          prepare: async () => ({ text: "Say done", images: [], release: () => {} }),
        },
        "owned-surface",
        page,
      ),
    ).rejects.toBeInstanceOf(ChatGptCompactionHandoffAccepted);

    const busHistory: ChatGptTurnEvent[] =
      worker.turnEventBuses?.get("completion_compaction_handoff")?.exportHistory() ?? [];
    expect(busHistory.some((event) => event.type === "compaction_handoff_observed")).toBe(true);
  } finally {
    rmSync(diagnostics, { recursive: true, force: true });
  }
}, 15_000);
