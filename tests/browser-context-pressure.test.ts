import { describe, expect, test } from "bun:test";
import {
  CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT,
  CHATGPT_BROWSER_SLOW_OBSERVATION_MS,
  ChatGptBrowserContextPressure,
  ChatGptPageDomObserver,
} from "../src/adapters/chatgpt-web/browser/context-pressure";

test("page DOM measurement is throttled per page and only scans changed responses", async () => {
  const observer = new ChatGptPageDomObserver(5_000);
  let scans = 0;
  const page = {
    evaluate: async () => { scans += 1; return 700_001; },
  };
  const pressure = new ChatGptBrowserContextPressure();
  await observer.measure(page as never, true, 1_000, () => pressure, 1_000);
  await observer.measure(page as never, true, 1_100, () => pressure, 2_000);
  await observer.measure(page as never, false, 1_100, () => pressure, 7_000);
  expect(scans).toBe(1);
  expect(pressure.snapshot().watchDomSize).toBeTrue();
  await observer.measure(page as never, true, 7_000, () => pressure, 7_001);
  expect(scans).toBe(2);
});

describe("ChatGPT browser context pressure", () => {
  test("watches a large DOM without interrupting a viable turn", () => {
    const pressure = new ChatGptBrowserContextPressure();

    pressure.recordObservation({
      domChars: CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT + 1,
      elapsedMs: 10,
    });

    expect(pressure.snapshot()).toMatchObject({
      compactionRequired: false,
      watchDomSize: true,
    });
  });

  test("requests bounded same-page recovery after two slow observations", () => {
    const pressure = new ChatGptBrowserContextPressure();

    pressure.recordObservation({ domChars: 100, elapsedMs: CHATGPT_BROWSER_SLOW_OBSERVATION_MS });
    expect(pressure.snapshot().compactionRequired).toBeFalse();

    pressure.recordObservation({ domChars: 100, elapsedMs: CHATGPT_BROWSER_SLOW_OBSERVATION_MS });
    expect(pressure.snapshot()).toMatchObject({ compactionRequired: false, recoveryRequired: true });
    pressure.recordRecovery();
    pressure.recordObservation({ domChars: 100, elapsedMs: CHATGPT_BROWSER_SLOW_OBSERVATION_MS });
    expect(pressure.snapshot()).toMatchObject({ compactionRequired: true, reason: "slow_observations" });
  });

  test("a fast post-recovery observation clears pressure", () => {
    const pressure = new ChatGptBrowserContextPressure();
    pressure.recordObservation({ domChars: 700_000, elapsedMs: 5_000 });
    pressure.recordObservation({ domChars: 700_000, elapsedMs: 5_000 });
    pressure.recordRecovery();
    pressure.recordObservation({ domChars: 700_000, elapsedMs: 30 });
    expect(pressure.snapshot()).toMatchObject({ compactionRequired: false, recoveryRequired: false });
  });
});
