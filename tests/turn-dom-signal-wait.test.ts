import { expect, test } from "bun:test";
import type { Locator, Page } from "playwright-core";
import { chatGptActiveComposer } from "../src/adapters/chatgpt-web/browser/composer";
import { ChatGptCompletionTracker } from "../src/adapters/chatgpt-web/browser/dom-trackers";
import { resolveChatGptToolConfirmation } from "../src/adapters/chatgpt-web/browser/overlays";
import { setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser/payloads";
import { ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser/suspension-clock";
import { ChatGptTurnEventBus } from "../src/adapters/chatgpt-web/browser/turn-events";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

function signalWorker(counters: { signalWaits: number; mutationWaits: number }) {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as Record<string, unknown>;
  worker.submissionDomState = async () => ({
    userTurnCount: 0,
    assistantTurnCount: 0,
    visibleStopButtonCount: 0,
    turnIdentities: [],
    userIdentities: [],
    responseIdentities: [],
  });
  worker.waitForTurnDomRevisionOrExternalProgress = async () => {
    counters.signalWaits += 1;
    return "document:0";
  };
  worker.waitForTurnDomOrExternalProgress = async () => {
    counters.mutationWaits += 1;
  };
  return worker as unknown as {
    waitForNewAssistantTurn(
      page: Page,
      baseline: unknown,
      deadline: number | undefined,
      signal?: AbortSignal,
      externalProgress?: unknown,
      graceMs?: number,
      completionTracker?: unknown,
      recoverObservation?: unknown,
      turnEvents?: ChatGptTurnEventBus,
    ): Promise<{ identity: string }>;
  };
}

const quietPage = {
  isClosed: () => false,
  locator: () => {
    const locator: Record<string, unknown> = {
      filter: () => locator,
      last: () => locator,
      isVisible: async () => false,
      count: async () => 0,
    };
    return locator;
  },
  evaluate: async () => undefined,
} as unknown as Page;

test("waitForNewAssistantTurn waits on the DOM revision signal, not the fixed mutation beat", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters);
  const baseline = { initialTurnIdentities: [], domCache: {} };
  await expect(
    worker.waitForNewAssistantTurn(quietPage, baseline, undefined, undefined, undefined, 250),
  ).rejects.toThrow("did not expose its assistant turn");
  expect(counters.signalWaits).toBeGreaterThanOrEqual(1);
  expect(counters.mutationWaits).toBe(0);
});

test("waitForNewAssistantTurn keeps binding a mounted assistant turn immediately", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters);
  (worker as unknown as Record<string, unknown>).submissionDomState = async () => ({
    userTurnCount: 1,
    assistantTurnCount: 1,
    visibleStopButtonCount: 0,
    turnIdentities: ["group:user:1", "group:assistant:1"],
    userIdentities: ["group:user:1"],
    responseIdentities: ["group:assistant:1"],
  });
  const baseline = { initialTurnIdentities: [], domCache: {} };
  const binding = await worker.waitForNewAssistantTurn(quietPage, baseline, Date.now() + 2_000);
  expect(binding.identity).toBe("group:assistant:1");
  expect(counters.signalWaits).toBe(0);
  expect(counters.mutationWaits).toBe(0);
});

test("waitForNewAssistantTurn publishes turn_inserted_detected to turnEvents when bound", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters);
  (worker as unknown as Record<string, unknown>).submissionDomState = async () => ({
    userTurnCount: 1,
    assistantTurnCount: 1,
    visibleStopButtonCount: 0,
    turnIdentities: ["group:user:1", "group:assistant:1"],
    userIdentities: ["group:user:1"],
    responseIdentities: ["group:assistant:1"],
  });
  const baseline = { initialTurnIdentities: [], domCache: {} };
  const events = new ChatGptTurnEventBus({ turnId: "turn-test" });
  const binding = await worker.waitForNewAssistantTurn(
    quietPage,
    baseline,
    Date.now() + 2_000,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    events,
  );
  expect(binding.identity).toBe("group:assistant:1");
  const history = events.exportHistory();
  expect(history.some((e) => e.type === "turn_inserted_detected")).toBe(true);
});

test("waitForSubmissionAccepted waits on the DOM revision signal, not the fixed mutation beat", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters) as unknown as Record<string, unknown> & {
    waitForSubmissionAccepted: (page: Page, baseline: unknown) => Promise<string>;
  };
  let probes = 0;
  worker.currentSubmissionEvidence = async () => {
    probes += 1;
    return probes >= 2 ? "assistant_turn" : undefined;
  };
  const baseline = { initialTurnIdentities: [], domCache: {} };
  const evidence = await worker.waitForSubmissionAccepted(quietPage, baseline);
  expect(evidence).toBe("assistant_turn");
  expect(counters.signalWaits).toBeGreaterThanOrEqual(1);
  expect(counters.mutationWaits).toBe(0);
});

test("selectConnector publishes connector_pill_mounted to turnEvents when mounted", async () => {
  const events = new ChatGptTurnEventBus({ turnId: "turn-connector" });
  let selected = false;
  const initialComposer = {
    fill: async () => {},
    focus: async () => {},
    pressSequentially: async () => {},
    press: async () => {
      selected = true;
    },
  };
  const selectedConnector = {
    waitFor: async () => {},
  };
  const selectedComposer = {
    ...initialComposer,
  };

  const appResult = {
    waitFor: async () => {},
    count: async () => 1,
    evaluate: async () => false,
    getAttribute: async () => "true",
  };
  const menuRows = {
    filter: () => appResult,
  };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=false",
    locator: () => menuRows,
    getByText: () => ({}),
  } as unknown as Page;

  const selectConnector = (
    ChatGptBrowserWorker.prototype as unknown as {
      selectConnector(
        page: Page,
        capture?: unknown,
        refresh?: boolean,
        budget?: unknown,
        abort?: unknown,
        hasTurns?: boolean,
        turnEvents?: ChatGptTurnEventBus,
      ): Promise<unknown>;
    }
  ).selectConnector;

  await selectConnector.call(
    {
      config: { appName: "Codex Native2" },
      connectorIsSelected: async () => selected,
      connectorMentionRowTitles: async () => [],
      selectedConnectorControl: () => selectedConnector,
      activeComposer: async () => (selected ? selectedComposer : initialComposer),
    },
    page,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    events,
  );

  const history = events.exportHistory();
  expect(history.some((e) => e.type === "connector_pill_mounted")).toBe(true);
});

test("waitForMultipartAcknowledgement waits on the DOM revision signal without fixed setTimeout", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters) as unknown as Record<string, any>;
  const events = new ChatGptTurnEventBus({ turnId: "turn-multipart-signal" });
  let snapshotIteration = 0;
  worker.responseDomSnapshot = async () => {
    snapshotIteration += 1;
    if (snapshotIteration === 1) {
      return {
        responsePresent: false,
        stoppedThinkingVisible: false,
        visibleText: "",
        completionActionVisible: false,
        fullHtml: "",
      };
    }
    return {
      responsePresent: true,
      stoppedThinkingVisible: false,
      visibleText: "STAGE_1_ACK",
      completionActionVisible: true,
      fullHtml: "<p>STAGE_1_ACK</p>",
    };
  };

  const observe = (ChatGptBrowserWorker.prototype as any).waitForMultipartAcknowledgement;
  const mockLocator: Record<string, any> = {
    filter: () => mockLocator,
    last: () => mockLocator,
    first: () => mockLocator,
    getByTestId: () => mockLocator,
    getByText: () => mockLocator,
    locator: () => mockLocator,
    isVisible: async () => false,
    count: async () => 0,
    waitFor: async () => {},
  };
  const mockPage = {
    isClosed: () => false,
    locator: () => mockLocator,
  } as unknown as Page;

  const stage = { acknowledgement: "STAGE_1_ACK" };
  const baseline = { initialTurnIdentities: [], domCache: {} };
  const binding = { locator: (mockPage as any).locator(), identity: "turn-1", acceptedTurnIdentities: [] };
  const completionTracker = new ChatGptCompletionTracker(0);
  let activeToolCalls = 1;
  const externalProgress = {
    snapshot: () => ({
      revision: 1,
      lastToolBatchRevision: 1,
      lastProgressAt: Date.now(),
      activeToolCalls,
      claimed: true,
    }),
    acknowledgeToolBatch: async () => {
      activeToolCalls = 0;
    },
  };

  await observe.call(
    worker,
    mockPage,
    binding,
    baseline,
    stage,
    Date.now() + 10_000,
    undefined,
    externalProgress,
    completionTracker,
    events,
  );

  expect(counters.signalWaits).toBeGreaterThanOrEqual(1);
  const history = events.exportHistory();
  expect(history.some((e) => e.type === "response_mutated")).toBe(true);
});

test("waitForSubmissionAcceptedWithRecovery uses DOM revision signal and suppresses probe timeout when generation is running", async () => {
  const counters = { signalWaits: 0, mutationWaits: 0 };
  const worker = signalWorker(counters) as unknown as Record<string, any>;
  let probes = 0;
  worker.waitForSubmissionAccepted = async () => {
    probes += 1;
    if (probes === 1) {
      throw new ChatGptBrowserObservationTimeoutError(6000);
    }
    return "user_turn";
  };

  const runningPage = {
    isClosed: () => false,
    locator: (_selector: string | string[]) => ({
      last: () => ({
        isVisible: async () => true, // Stop button is visible
      }),
      count: async () => 1,
    }),
  } as unknown as Page;

  const baseline = { initialTurnIdentities: [], domCache: {} };
  const recoverObserve = (ChatGptBrowserWorker.prototype as any).waitForSubmissionAcceptedWithRecovery;
  const evidence = await recoverObserve.call(worker, runningPage, baseline);

  expect(evidence).toBe("user_turn");
  expect(counters.signalWaits).toBeGreaterThanOrEqual(1);
});

test("chatGptActiveComposer waits on DOM revision signal instead of blind setTimeout", async () => {
  let domSignalWaits = 0;
  let countProbes = 0;
  const mockComposer = { isComposer: true };
  const mockPage = {
    isClosed: () => false,
    locator: () => ({
      filter: () => ({
        count: async () => {
          countProbes += 1;
          return countProbes >= 2 ? 1 : 0;
        },
        first: () => mockComposer,
      }),
    }),
    evaluate: async (_fn: any, args: any) => {
      if (args && Array.isArray(args.attributeFilter)) {
        domSignalWaits += 1;
        return { key: `doc:${domSignalWaits}`, revision: domSignalWaits, timedOut: false };
      }
      return undefined;
    },
  } as unknown as Page;

  const composer = await chatGptActiveComposer(mockPage, 1_000);
  expect(composer).toBe(mockComposer as any);
  expect(domSignalWaits).toBeGreaterThanOrEqual(1);
});

test("setChatGptThinkMode waits on DOM revision signal when updating aria-pressed", async () => {
  let domSignalWaits = 0;
  let pressedProbes = 0;
  const mockRow = {
    waitFor: async () => {},
    getAttribute: async (name: string) => (name === "data-highlighted" ? "true" : null),
    press: async () => {},
  };
  const mockRows = {
    first: () => mockRow,
    count: async () => 1,
  };
  const mockPopup = {
    count: async () => 1,
    locator: () => ({
      filter: () => mockRows,
    }),
  };
  const mockPage = {
    isClosed: () => false,
    evaluate: async (_fn: any, args: any) => {
      if (args && Array.isArray(args.attributeFilter)) {
        domSignalWaits += 1;
        return { key: `doc:${domSignalWaits}`, revision: domSignalWaits, timedOut: false };
      }
      return undefined;
    },
    locator: () => ({
      filter: () => mockPopup,
    }),
  } as unknown as Page;

  const mockControl = {
    getAttribute: async (name: string) => {
      if (name === "aria-pressed") {
        pressedProbes += 1;
        return pressedProbes >= 3 ? "true" : "false";
      }
      return null;
    },
  };

  const mockComposerForm = {
    page: () => mockPage,
    getByRole: () => ({
      filter: () => ({
        count: async () => 1,
        first: () => mockControl,
      }),
    }),
    locator: () => ({
      filter: () => ({
        first: () => ({
          evaluate: async () => ({ text: "", connectors: [] }),
          focus: async () => {},
          press: async () => {},
          pressSequentially: async () => {},
        }),
      }),
    }),
  } as unknown as Locator;

  await setChatGptThinkMode(mockComposerForm, true);
  expect(domSignalWaits).toBeGreaterThanOrEqual(1);
});

test("resolveChatGptToolConfirmation waits on DOM revision signal when autoApprove is false", async () => {
  let domSignalWaits = 0;
  let dialogVisibleProbes = 0;
  const mockDialog = {
    isVisible: async () => {
      dialogVisibleProbes += 1;
      return dialogVisibleProbes <= 3;
    },
  };
  const mockPage = {
    isClosed: () => false,
    evaluate: async (_fn: any, args: any) => {
      if (args && Array.isArray(args.attributeFilter)) {
        domSignalWaits += 1;
        return { key: `doc:${domSignalWaits}`, revision: domSignalWaits, timedOut: false };
      }
      return undefined;
    },
    locator: () => {
      const self: any = {
        filter: () => self,
        last: () => mockDialog,
      };
      return self;
    },
  } as unknown as Page;

  const resolved = await resolveChatGptToolConfirmation(mockPage, "TestApp", false, undefined, 500);
  expect(resolved).toBe(true);
  expect(domSignalWaits).toBeGreaterThanOrEqual(1);
});
