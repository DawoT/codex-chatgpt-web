import { join } from "node:path";
import { stderr } from "node:process";
import { getConfigDir } from "../config";
import {
  createDiagnosticProducer,
  type DiagnosticEventInput,
  DiagnosticEventRing,
  type DiagnosticEventV2,
  type DiagnosticProducer,
} from "./events";
import { DiagnosticSink } from "./sink";

export * from "./errors";
export * from "./events";
export * from "./sink";

const producers = new Map<DiagnosticProducer, ReturnType<typeof createDiagnosticProducer>>();
const ring = new DiagnosticEventRing();
let sink: DiagnosticSink<DiagnosticEventV2> | undefined;

function diagnosticSink(): DiagnosticSink<DiagnosticEventV2> {
  sink ??= new DiagnosticSink(join(getConfigDir(), "logs", "harness"), {
    fallback: (event, failure) => {
      stderr.write(`${JSON.stringify({ ...event, sinkFailure: failure })}\n`);
    },
  });
  return sink;
}

export function diagnosticHealth() {
  return diagnosticSink().health();
}

export function flushDiagnostics(deadlineMs = 1000): Promise<boolean> {
  return sink?.flush(deadlineMs) ?? Promise.resolve(true);
}

/** Internal integration hook. Observers may be a sink's record method; failure never changes the operation. */
export function emitDiagnosticEvent(
  input: DiagnosticEventInput & { producer: DiagnosticProducer },
  options?: { ring?: DiagnosticEventRing; write?: (event: DiagnosticEventV2) => unknown },
): DiagnosticEventV2 {
  let produce = producers.get(input.producer);
  if (!produce) {
    produce = createDiagnosticProducer(input.producer);
    producers.set(input.producer, produce);
  }
  const event = produce(input);
  (options?.ring ?? ring).record(event);
  try {
    void diagnosticSink()
      .record(event)
      .catch(() => undefined);
    const write =
      options?.write ??
      ((entry: DiagnosticEventV2) => {
        if (entry.phase === "failed" || entry.phase === "dropped") console.error(JSON.stringify(entry));
      });
    void Promise.resolve(write(event)).catch(() => undefined);
  } catch {
    // Diagnostic delivery never changes execution or transport callback delivery.
  }
  return event;
}

export function snapshotDiagnosticEvents(turnId: string): ReturnType<DiagnosticEventRing["snapshot"]> {
  return ring.snapshot(turnId);
}
