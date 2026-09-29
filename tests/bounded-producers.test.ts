import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleExecCommand } from "../src/adapters/chatgpt-web/fast-path/exec";
import { handleReadFile } from "../src/adapters/chatgpt-web/fast-path/file-ops";

describe("Bounded Producers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bounded-prod-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("byte pages resume at explicit byte offsets without splitting UTF-8", async () => {
    await writeFile(join(tempDir, "unicode.txt"), "ab😀cdéfg");
    let offset = 0;
    let content = "";
    for (let page = 0; page < 10; page += 1) {
      const res = handleReadFile({
        path: "unicode.txt",
        cwd: tempDir,
        roots: [tempDir],
        max_bytes: 5,
        offset_bytes: offset,
      });
      expect(Boolean(res.isError)).toBe(false);
      const data = res.structuredContent as any;
      content += data.content;
      expect(Buffer.byteLength(data.content)).toBeLessThanOrEqual(5);
      if (data.next_offset_bytes === null) break;
      expect(data.next_offset_bytes).toBeGreaterThan(offset);
      offset = data.next_offset_bytes;
    }
    expect(content).toBe("ab😀cdéfg");
  });

  it("rejects invalid byte budgets and mixed line/byte pagination", async () => {
    await writeFile(join(tempDir, "budget.txt"), "content");
    for (const extra of [
      { max_bytes: Infinity },
      { max_bytes: -1 },
      { max_bytes: 1.5 },
      { max_bytes: 2 ** 30 },
      { max_bytes: 8, offset: 2 },
    ]) {
      const res = handleReadFile({ path: "budget.txt", cwd: tempDir, roots: [tempDir], ...extra });
      expect(res.isError).toBe(true);
    }
  });

  it("counts omitted stderr bytes and preserves a UTF-8 stdout prefix", async () => {
    const cmd = `${process.execPath} -e "process.stdout.write('😀'.repeat(400000)); process.stderr.write('é'.repeat(800000))"`;
    const res = await handleExecCommand({ cmd, cwd: tempDir, roots: [tempDir], writableRoots: [tempDir] });
    const data = res.structuredContent as any;
    const stdout = data.stdout.split("\n[codex_exec:")[0];
    const stderr = data.stderr.split("\n[codex_exec:")[0];
    expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(1024 * 1024);
    expect(stdout).not.toContain("�");
    expect(data.omitted_bytes).toBe(3200000 - Buffer.byteLength(stdout) - Buffer.byteLength(stderr));
    expect(data.stdout_omitted_bytes).toBe(1600000 - Buffer.byteLength(stdout));
    expect(data.stderr_omitted_bytes).toBe(1600000 - Buffer.byteLength(stderr));
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
    expect(typeof data.next_offset_bytes).toBe("number");
    expect(data.next_offset_bytes).toBe(data.read_bytes);
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
