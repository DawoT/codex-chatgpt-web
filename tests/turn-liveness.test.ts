/** Observable liveness contracts: broker ownership expires as evidence; active tools veto completion. */
import { expect, test } from "bun:test";
import { CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS } from "../src/adapters/chatgpt-web/browser/dom-trackers";
import { CATASTROPHIC_SILENCE_THRESHOLD_MS } from "../src/adapters/chatgpt-web/browser/suspension-clock";
import { resolveTurnLivenessSignals } from "../src/adapters/chatgpt-web/browser/turn-liveness";
import type { ChatGptExternalTurnProgressSnapshot } from "../src/adapters/chatgpt-web/turn-progress";

const NOW = 1_800_000_000_000;

test("a claimed broker with no tools and an hour of silence cannot keep a disconnected turn alive", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ claimed: true, lastProgressAt: NOW - 3_600_000 }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
  });
});

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

test("claimed progress past the stall ceiling loses liveness on every channel", () => {
  expect(
    resolveTurnLivenessSignals(
      snapshotOf({ claimed: true, lastProgressAt: NOW - CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS }),
      NOW,
    ),
  ).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
  });
});

test("a recent claim can suppress DOM health without pretending a tool is still in flight", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ claimed: true, lastProgressAt: NOW - 100_000 }), NOW)).toEqual({
    externalProgressLive: true,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
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

test("a claim without active calls or a timestamp supplies no liveness evidence", () => {
  expect(resolveTurnLivenessSignals(snapshotOf({ claimed: true }), NOW)).toEqual({
    externalProgressLive: false,
    externalToolCallsInFlight: false,
    multiChannelLivenessActive: false,
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
