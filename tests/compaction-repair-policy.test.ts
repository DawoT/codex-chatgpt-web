import { expect, test } from "bun:test";
import { shouldRepairCheckpoint } from "../src/adapters/chatgpt-web/compaction-repair";

test("checkpoint repair needs room in both the deadline and transport", () => {
  expect(shouldRepairCheckpoint({ remainingMs: 120_000, transportFits: true, observedDurationsMs: [] })).toBeTrue();
  expect(shouldRepairCheckpoint({ remainingMs: 119_999, transportFits: true, observedDurationsMs: [] })).toBeFalse();
  expect(shouldRepairCheckpoint({ remainingMs: 200_000, transportFits: false, observedDurationsMs: [] })).toBeFalse();
  expect(shouldRepairCheckpoint({ remainingMs: 179_999, transportFits: true, observedDurationsMs: [150_000] })).toBeFalse();
  expect(shouldRepairCheckpoint({ remainingMs: 180_000, transportFits: true, observedDurationsMs: [150_000] })).toBeTrue();
});
