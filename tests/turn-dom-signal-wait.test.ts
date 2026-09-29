import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
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
