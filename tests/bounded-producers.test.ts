import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleReadFile } from "../src/adapters/chatgpt-web/fast-path/file-ops";
import { handleExecCommand } from "../src/adapters/chatgpt-web/fast-path/exec";

describe("Bounded Producers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bounded-prod-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("handleReadFile caps large reads at 128 KiB chunk budget and provides continuation offset", async () => {
    // Create a 2 MiB file (~2,097,152 bytes) with repeating lines
    const line = "Line of content for bounded producer test verification.\n";
    const lineCount = Math.ceil((2 * 1024 * 1024) / line.length);
    const content = line.repeat(lineCount);
    const filePath = join(tempDir, "large-sample.txt");
    await writeFile(filePath, content, "utf8");

    const res = handleReadFile({
      path: "large-sample.txt",
      cwd: tempDir,
      roots: [tempDir],
      max_bytes: 128 * 1024, // 128 KiB bounded chunk
    });

    expect(Boolean(res.isError)).toBe(false);
    expect(res.structuredContent).toBeDefined();
    const data = res.structuredContent as any;
    expect(data.read_bytes).toBeLessThanOrEqual(128 * 1024);
    expect(data.truncated).toBe(true);
    expect(data.total_bytes).toBeGreaterThan(1024 * 1024);
    expect(typeof data.next_offset).toBe("number");
    expect(data.next_offset).toBe(data.read_bytes);
  });

  it("handleExecCommand bounds real-time streaming to 1 MiB and flags stdout_truncated", async () => {
    // Run a command that produces 3 MiB of stdout text
    const cmd = `${process.execPath} -e "process.stdout.write('X'.repeat(3 * 1024 * 1024))"`;

    const res = await handleExecCommand({
      cmd,
      cwd: tempDir,
      roots: [tempDir],
      writableRoots: [tempDir],
    });

    expect(Boolean(res.isError)).toBe(false);
    const data = res.structuredContent as any;
    expect(data.stdout_truncated).toBe(true);
    expect(Buffer.byteLength(data.stdout, "utf8")).toBeLessThanOrEqual(1024 * 1024 + 1024);
    expect(data.omitted_bytes).toBeGreaterThan(1024 * 1024);
  });
});
