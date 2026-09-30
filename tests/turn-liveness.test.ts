/**
 * Pins the aggregation semantics of `resolveTurnLivenessSignals`, the pure classifier that will
 * replace the six hand-rolled liveness computations in browser-worker.ts (waitForMultipartAcknowledgement,
 * recoverStalledResponsePage and three completion-loop sites).
 *
 * Expectations are hand-derived from the three underlying functions the module delegates to:
 * - `chatGptExternalProgressSuppressesDomHealth` (dom-trackers.ts): live requires claimed /
 *   activeToolCalls > 0 / lastProgressAt within CHATGPT_RESPONSE_DOM_GRACE_MS, AND a
 *   lastProgressAt whose age sits within [-CLOCK_SKEW, STALL_CEILING).
 * - `chatGptExternalToolCallsAreInFlight` (turn-progress.ts): activeToolCalls > 0.
 * - `isMultiChannelLivenessActive` (suspension-clock.ts): activeToolCalls > 0 or inFlightCalls,
 *   else lastProgressAt (as lastBrokerEventAt) within CATASTROPHIC_SILENCE_THRESHOLD_MS of now.
 *
 * Where useful the underlying functions are invoked directly as the oracle: the unit under test
 * is the aggregation wiring, so the final test re-derives every fixture's expected signals from
 * the three real functions and asserts the classifier agrees.
 */
import { expect, test } from "bun:test";
import {
  CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  chatGptExternalProgressSuppressesDomHealth,
} from "../src/adapters/chatgpt-web/browser/dom-trackers";
import {
  CATASTROPHIC_SILENCE_THRESHOLD_MS,
  isMultiChannelLivenessActive,
} from "../src/adapters/chatgpt-web/browser/suspension-clock";
import { resolveTurnLivenessSignals } from "../src/adapters/chatgpt-web/browser/turn-liveness";
import {
  type ChatGptExternalTurnProgressSnapshot,
  chatGptExternalToolCallsAreInFlight,
} from "../src/adapters/chatgpt-web/turn-progress";

const NOW = 1_800_000_000_000;

function snapshotOf(overrides: Partial<ChatGptExternalTurnProgressSnapshot> = {}): ChatGptExternalTurnProgressSnapshot {
  return { revision: 1, lastToolBatchRevision: 0, activeToolCalls: 0, ...overrides };
}

test("an undefined snapshot reports no liveness on any channel", () => {
  expect(resolveTurnLivenessSignals(undefined, NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
  });
});

test("fresh lastProgressAt proves external progress and multi-channel liveness", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW - 1_000 }), NOW)).toEqual({
    externalProgressLive: true,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("claimed progress past the stall ceiling stops suppressing DOM health but keeps multi-channel liveness", () => {
  // claimed keeps the snapshot "live" for the grace check, but the recorded progress is exactly at
  // the staleness ceiling, so DOM health is no longer suppressed. `claimed` still feeds
  // inFlightCalls, which holds multi-channel liveness open.
  expect(
    resolveTurnLivenessSignals(
      snapshotOf({ claimed: true, lastProgressAt: NOW - CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS }),
      NOW,
    ),
  ).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("claimed progress between the grace and silence windows keeps DOM suppression and multi-channel liveness", () => {
  // 100s of broker silence exceeds the catastrophic-silence threshold, but `claimed` feeds
  // inFlightCalls, which short-circuits multi-channel liveness regardless of recency. In general
  // externalProgressLive implies multiChannelLivenessActive: each of claimed, active tool calls
  // and fresh lastProgressAt independently forces the multi-channel signal on.
  expect(resolveTurnLivenessSignals(snapshotOf({ claimed: true, lastProgressAt: NOW - 100_000 }), NOW)).toEqual({
    externalProgressLive: true,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("unclaimed progress in the grace-to-silence window keeps multi-channel liveness without DOM suppression", () => {
  // Past the 60s DOM grace the progress no longer suppresses DOM health, yet the 90s
  // catastrophic-silence threshold still holds the multi-channel signal open.
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW - 70_000 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("active tool calls put calls in flight and hold multi-channel liveness without DOM suppression", () => {
  // Without a recorded lastProgressAt the DOM-suppression signal stays off even though calls are
  // active; the multi-channel channel stays alive via activeToolCalls.
  expect(resolveTurnLivenessSignals(snapshotOf({ activeToolCalls: 2 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: true,
    multiChannelLivenessActive: true,
  });
});

test("active tool calls keep multi-channel liveness even when the recorded progress went stale", () => {
  expect(
    resolveTurnLivenessSignals(
      snapshotOf({ activeToolCalls: 1, lastProgressAt: NOW - CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS }),
      NOW,
    ),
  ).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: true,
    multiChannelLivenessActive: true,
  });
});

test("a claim without active calls or a timestamp holds multi-channel liveness via inFlightCalls", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ claimed: true }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("lastProgressAt slightly in the future (within the clock skew) reads as live on every channel", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW + 4_000 }), NOW)).toEqual({
    externalProgressLive: true,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("lastProgressAt beyond the clock skew loses DOM suppression while multi-channel liveness tolerates it", () => {
  // isMultiChannelLivenessActive has no future guard: any negative age is below its silence
  // threshold, so only suppressesDomHealth rejects a far-future timestamp.
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW + 10_000 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("lastProgressAt exactly at the DOM grace boundary stops DOM suppression but multi-channel stays alive", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW - 60_000 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: true,
  });
});

test("lastProgressAt exactly at the silence threshold drops multi-channel liveness", () => {
  expect(
    resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW - CATASTROPHIC_SILENCE_THRESHOLD_MS }), NOW),
  ).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
  });
});

test("stale, unclaimed, tool-free progress reports no liveness anywhere", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ lastProgressAt: NOW - 3_600_000 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
  });
});

test("the classifier agrees with the underlying functions on every fixture, matching the production wiring", () => {
  // Oracle: the exact aggregation the six browser-worker.ts copies perform (now threaded into
  // isMultiChannelLivenessActive instead of read from Date.now() at the call instant).
  const fixtures: Array<ChatGptExternalTurnProgressSnapshot | undefined> = [
    undefined,
    snapshotOf(),
    snapshotOf({ lastProgressAt: NOW - 1_000 }),
    snapshotOf({ claimed: true, lastProgressAt: NOW - CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS }),
    snapshotOf({ claimed: true, lastProgressAt: NOW - 100_000 }),
    snapshotOf({ activeToolCalls: 2 }),
    snapshotOf({ activeToolCalls: 1, lastProgressAt: NOW - CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS }),
    snapshotOf({ claimed: true }),
    snapshotOf({ lastProgressAt: NOW + 4_000 }),
    snapshotOf({ lastProgressAt: NOW + 10_000 }),
    snapshotOf({ lastProgressAt: NOW - 60_000 }),
    snapshotOf({ lastProgressAt: NOW - CATASTROPHIC_SILENCE_THRESHOLD_MS }),
    snapshotOf({ lastProgressAt: NOW - 3_600_000 }),
    snapshotOf({ claimed: true, activeToolCalls: 3, lastProgressAt: NOW - 2_000 }),
  ];
  for (const fixture of fixtures) {
    const expected = {
      externalProgressLive: chatGptExternalProgressSuppressesDomHealth(fixture, NOW),
      externalToolCallsInFlight: chatGptExternalToolCallsAreInFlight(fixture),
      multiChannelLivenessActive: isMultiChannelLivenessActive(
        {
          lastBrokerEventAt: fixture?.lastProgressAt,
          activeToolCalls: fixture?.activeToolCalls,
          inFlightCalls: chatGptExternalToolCallsAreInFlight(fixture) || fixture?.claimed,
        },
        NOW,
      ),
    };
    expect(resolveTurnLivenessSignals(fixture, NOW)).toEqual(expected);
  }
});
