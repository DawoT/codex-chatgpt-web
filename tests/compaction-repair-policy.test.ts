import { expect, test } from "bun:test";
import { recordRepairDuration, shouldRepairCheckpoint } from "../src/adapters/chatgpt-web/compaction-repair";

test("checkpoint repair needs room in both the deadline and transport", () => {
  expect(shouldRepairCheckpoint({ remainingMs: 120_000, transportFits: true, observedDurationsMs: [] })).toBeTrue();
  expect(shouldRepairCheckpoint({ remainingMs: 119_999, transportFits: true, observedDurationsMs: [] })).toBeFalse();
  expect(shouldRepairCheckpoint({ remainingMs: 200_000, transportFits: false, observedDurationsMs: [] })).toBeFalse();
  expect(
    shouldRepairCheckpoint({ remainingMs: 179_999, transportFits: true, observedDurationsMs: [150_000] }),
  ).toBeFalse();
  expect(
    shouldRepairCheckpoint({ remainingMs: 180_000, transportFits: true, observedDurationsMs: [150_000] }),
  ).toBeTrue();
});

test("slow failed repairs raise the deadline estimate, but operator cancellations do not", () => {
  const durations: number[] = [];
  recordRepairDuration(durations, 1_000, 151_000, "failed");
  expect(durations).toEqual([150_000]);
  expect(
    shouldRepairCheckpoint({
      remainingMs: 179_999,
      transportFits: true,
      observedDurationsMs: durations,
    }),
  ).toBeFalse();
  expect(
    shouldRepairCheckpoint({
      remainingMs: 180_000,
      transportFits: true,
      observedDurationsMs: durations,
    }),
  ).toBeTrue();
  recordRepairDuration(durations, 200_000, 600_000, "operator_cancelled");
  expect(durations).toEqual([150_000]);
});
