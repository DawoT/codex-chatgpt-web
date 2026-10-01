import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as diagnostics from "../src/diagnostics/sink";

test("retention bounds dead writer archives and preserves live writers and journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-retention-"));
  const api = diagnostics as unknown as {
    pruneDiagnosticArchives(
      directory: string,
      options: { now: number; maxAgeMs: number; maxBytes: number; isWriterActive(pid: number): boolean },
    ): Promise<{ removedFiles: number }>;
  };
  const generation = `${"a".repeat(8)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(4)}-${"a".repeat(12)}`;
  const name = (pid: number) => `telemetry.${pid}.${generation}.${generation}.jsonl`;
  const now = Date.now();
  try {
    expect(api.pruneDiagnosticArchives).toBeTypeOf("function");
    await writeFile(join(root, name(11)), "old");
    await writeFile(join(root, name(12)), "new".repeat(10));
    await writeFile(join(root, name(13)), "live");
    await writeFile(join(root, "events.sqlite"), "durable journal");
    await mkdir(join(root, ".telemetry.lock"));
    await utimes(join(root, name(11)), new Date(now - 2000), new Date(now - 2000));
    const result = await api.pruneDiagnosticArchives(root, {
      now,
      maxAgeMs: 1000,
      maxBytes: 8,
      isWriterActive: (pid) => pid === 13,
    });
    expect(result.removedFiles).toBe(2);
    expect(await readFile(join(root, name(13)), "utf8")).toBe("live");
    expect(await readFile(join(root, "events.sqlite"), "utf8")).toBe("durable journal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
