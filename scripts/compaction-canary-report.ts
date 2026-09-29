import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const EVENT_PREFIX = "[chatgpt-web] compaction_event ";

interface CanaryEvent {
  schemaVersion: number;
  traceId: string;
  phase: string;
  outcome: string;
  route: string;
  localPersisted?: boolean;
  runtime?: {
    generation?: string;
    artifactSha256?: string | null;
    protocolVersion?: number;
  };
}

interface TraceSummary {
  phases: Set<string>;
  builds: Set<string>;
  route: string;
  persisted: boolean;
  skippedPersistence: boolean;
  failed: boolean;
  rejected: boolean;
}

export interface CompactionCanaryReport {
  traces: number;
  durableCompleted: number;
  retainedDurableCompleted: number;
  fallbackDurableCompleted: number;
  deliveredWithoutLocalPersistence: number;
  rejected: number;
  failed: number;
  incomplete: number;
  mixedBuildTraces: number;
  malformedEvents: number;
}

export class CompactionCanaryAccumulator {
  private readonly traces = new Map<string, TraceSummary>();
  private malformedEvents = 0;

  add(line: string): void {
    const marker = line.indexOf(EVENT_PREFIX);
    if (marker < 0) return;
    let event: CanaryEvent;
    try {
      event = JSON.parse(line.slice(marker + EVENT_PREFIX.length)) as CanaryEvent;
    } catch {
      this.malformedEvents += 1;
      return;
    }
    if (event.schemaVersion !== 1 || typeof event.traceId !== "string"
      || typeof event.phase !== "string" || !event.runtime?.generation) {
      this.malformedEvents += 1;
      return;
    }
    const trace = this.traces.get(event.traceId) ?? {
      phases: new Set<string>(),
      builds: new Set<string>(),
      route: "unknown",
      persisted: false,
      skippedPersistence: false,
      failed: false,
      rejected: false,
    };
    trace.phases.add(event.phase);
    trace.builds.add(JSON.stringify([
      event.runtime.protocolVersion,
      event.runtime.artifactSha256,
      event.runtime.generation,
    ]));
    if (event.route && event.route !== "unknown") trace.route = event.route;
    if (event.phase === "persisted") {
      trace.persisted ||= event.outcome === "succeeded" && event.localPersisted === true;
      trace.skippedPersistence ||= event.outcome === "skipped" && event.localPersisted === false;
    }
    if (event.phase === "failed") {
      trace.rejected ||= event.outcome === "rejected";
      trace.failed ||= event.outcome !== "rejected";
    }
    this.traces.set(event.traceId, trace);
  }

  report(): CompactionCanaryReport {
    const result: CompactionCanaryReport = {
      traces: this.traces.size,
      durableCompleted: 0,
      retainedDurableCompleted: 0,
      fallbackDurableCompleted: 0,
      deliveredWithoutLocalPersistence: 0,
      rejected: 0,
      failed: 0,
      incomplete: 0,
      mixedBuildTraces: 0,
      malformedEvents: this.malformedEvents,
    };
    for (const trace of this.traces.values()) {
      if (trace.builds.size > 1) {
        result.mixedBuildTraces += 1;
        continue;
      }
      if (trace.rejected) {
        result.rejected += 1;
        continue;
      }
      if (trace.failed) {
        result.failed += 1;
        continue;
      }
      if (trace.phases.has("accepted") && trace.phases.has("delivered")) {
        if (trace.persisted) {
          result.durableCompleted += 1;
          if (trace.route === "retained") result.retainedDurableCompleted += 1;
          if (trace.route === "fallback") result.fallbackDurableCompleted += 1;
          continue;
        }
        if (trace.skippedPersistence) {
          result.deliveredWithoutLocalPersistence += 1;
          continue;
        }
      }
      result.incomplete += 1;
    }
    return result;
  }
}

export function summarizeCompactionCanaryLines(lines: Iterable<string>): CompactionCanaryReport {
  const accumulator = new CompactionCanaryAccumulator();
  for (const line of lines) accumulator.add(line);
  return accumulator.report();
}

if (import.meta.main) {
  const file = process.argv[2];
  const input = file ? createReadStream(file, { encoding: "utf8" }) : process.stdin;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const accumulator = new CompactionCanaryAccumulator();
  for await (const line of lines) accumulator.add(line);
  process.stdout.write(`${JSON.stringify(accumulator.report(), null, 2)}\n`);
}
