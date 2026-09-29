import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptCompactionHandoffAccepted } from "../src/adapters/chatgpt-web/adapter-error";
import type { ChatGptTurnEvent } from "../src/adapters/chatgpt-web/browser/turn-events";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

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
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {
        appName: "Codex Native2",
        browserDiagnosticsPath: diagnostics,
        browserHostDescriptorPath: "owned-descriptor",
      },
      contextPressureByConversation: new Map(),
      contextPressureByPage: new WeakMap(),
      lastDomMeasurementByPage: new WeakMap(),
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
        onTextDelta: () => {},
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
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: {
        appName: "Codex Native2",
        browserDiagnosticsPath: diagnostics,
        browserHostDescriptorPath: "owned-descriptor",
      },
      contextPressureByConversation: new Map(),
      contextPressureByPage: new WeakMap(),
      lastDomMeasurementByPage: new WeakMap(),
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
