import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_MAX_READ_FILE_BYTES,
  handlePatchFile,
  handleReadFile,
  handleWriteFile,
  resolveSafeWorkspacePath,
  type FastPathToolResult,
} from "../src/adapters/chatgpt-web/fast-path-handlers";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

function payload(res: FastPathToolResult): Record<string, any> {
  return res.structuredContent as Record<string, any>;
}

describe("Sprint G: Fast-Path Mutation Tools (codex_write_file, codex_patch_file)", () => {
  describe("resolveSafeWorkspacePath sandbox safety for mutation", () => {
    test("allows paths inside the sandbox root", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-mutation-sandbox-"));
      try {
        const filePath = join(root, "src", "nested", "file.ts");
        const resolved = resolveSafeWorkspacePath("src/nested/file.ts", root, [root]);
        expect(resolved).toBe(filePath);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("blocks paths attempting path traversal escaping the sandbox root", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-mutation-escape-"));
      try {
        expect(() => resolveSafeWorkspacePath("../escape.ts", root, [root])).toThrow("outside allowed sandbox roots");
        expect(() => resolveSafeWorkspacePath("../../etc/shadow", root, [root])).toThrow("outside allowed sandbox roots");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("codex_write_file logic", () => {
    test("creates a new file and reports the relative path and byte count", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-test-"));
      try {
        const content = "export const Component = () => <div>Hello</div>;";
        const res = handleWriteFile({
          path: "deep/nested/dir/component.tsx",
          content,
          overwrite: false,
          create_parents: true,
          cwd: root,
          roots: [root],
          cache: new FastPathWorkspaceCache(),
        });
        expect(res.isError).toBeUndefined();
        const out = payload(res);
        expect(out.path).toBe(join("deep", "nested", "dir", "component.tsx"));
        expect(out.bytes_written).toBe(Buffer.byteLength(content, "utf8"));
        expect(out.overwrote).toBe(false);
        expect(readFileSync(join(root, "deep", "nested", "dir", "component.tsx"), "utf8")).toBe(content);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("protects an existing file when overwrite is false", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-protect-"));
      try {
        const filePath = join(root, "protected.txt");
        const original = "Do not overwrite me";
        writeFileSync(filePath, original, "utf8");

        const res = handleWriteFile({ path: "protected.txt", content: "hacked", cwd: root, roots: [root] });
        expect(res.isError).toBe(true);
        const out = payload(res);
        expect(out.error).toContain("already exists and overwrite is false");
        expect(out.path).toBe("protected.txt");
        expect(out.size_bytes).toBe(statSync(filePath).size);
        expect(typeof out.modified_epoch_ms).toBe("number");
        expect(readFileSync(filePath, "utf8")).toBe(original);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("overwrites an existing file when overwrite is true", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-overwrite-"));
      try {
        const filePath = join(root, "target.txt");
        writeFileSync(filePath, "Initial content", "utf8");

        const updated = "Updated content";
        const res = handleWriteFile({ path: "target.txt", content: updated, overwrite: true, cwd: root, roots: [root] });
        expect(res.isError).toBeUndefined();
        const out = payload(res);
        expect(out.overwrote).toBe(true);
        expect(out.bytes_written).toBe(Buffer.byteLength(updated, "utf8"));
        expect(readFileSync(filePath, "utf8")).toBe(updated);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("refuses to create missing parent directories unless create_parents is true", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-parents-"));
      try {
        const missingParent = handleWriteFile({ path: "missing/dir/file.txt", content: "x", cwd: root, roots: [root] });
        expect(missingParent.isError).toBe(true);
        expect(payload(missingParent).error).toContain("Parent directory does not exist");
        expect(existsSync(join(root, "missing"))).toBe(false);

        const created = handleWriteFile({
          path: "missing/dir/file.txt",
          content: "x",
          create_parents: true,
          cwd: root,
          roots: [root],
        });
        expect(created.isError).toBeUndefined();
        expect(readFileSync(join(root, "missing", "dir", "file.txt"), "utf8")).toBe("x");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects sandbox escapes: outside root, traversal, and escaping symlinks", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-escape-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-write-outside-"));
      try {
        writeFileSync(join(outsideDir, "victim.txt"), "secret");
        symlinkSync(join(outsideDir, "victim.txt"), join(root, "link.txt"));

        const options = { content: "hacked", overwrite: true, cwd: root, roots: [root] };
        expect(() => handleWriteFile({ ...options, path: join(outsideDir, "victim.txt") })).toThrow("outside allowed sandbox roots");
        expect(() => handleWriteFile({ ...options, path: "../escape.txt" })).toThrow("outside allowed sandbox roots");
        expect(() => handleWriteFile({ ...options, path: "link.txt" })).toThrow("outside allowed sandbox roots");
        expect(readFileSync(join(outsideDir, "victim.txt"), "utf8")).toBe("secret");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("invalidates the cached entry so later reads observe the new content", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-write-cache-"));
      try {
        const cache = new FastPathWorkspaceCache();
        const filePath = join(root, "cached.txt");
        writeFileSync(filePath, "stale", "utf8");
        // Populate the cache with the stale content first.
        expect(payload(handleReadFile({ path: "cached.txt", cwd: root, roots: [root], cache })).content).toBe("stale");

        const updated = "fresh content";
        handleWriteFile({ path: "cached.txt", content: updated, overwrite: true, cwd: root, roots: [root], cache });
        const reread = payload(handleReadFile({ path: "cached.txt", cwd: root, roots: [root], cache }));
        expect(reread.content).toBe(updated);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("codex_patch_file logic", () => {
    test("replaces only the first exact occurrence of the target content", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-patch-test-"));
      try {
        const fileContent = [
          "function calculateTax(amount: number): number {",
          "  const rate = 0.10;",
          "  return amount * rate;",
          "}",
          "const fallbackRate = 0.10;",
        ].join("\n");
        const filePath = join(root, "tax.ts");
        writeFileSync(filePath, fileContent, "utf8");

        const replacement = "  const rate = 0.18; // Updated for 2026 VAT";
        const res = handlePatchFile({
          path: "tax.ts",
          target_content: "  const rate = 0.10;",
          replacement_content: replacement,
          cwd: root,
          roots: [root],
          cache: new FastPathWorkspaceCache(),
        });
        expect(res.isError).toBeUndefined();
        const out = payload(res);
        expect(out.path).toBe("tax.ts");
        expect(out.replacements).toBe(1);
        expect(out.bytes_written).toBe(statSync(filePath).size);

        const finalContent = readFileSync(filePath, "utf8");
        expect(finalContent).toContain("const rate = 0.18; // Updated for 2026 VAT");
        expect(finalContent).toContain("function calculateTax");
        expect(finalContent).toContain("const fallbackRate = 0.10;");
        expect(finalContent).not.toContain("  const rate = 0.10;");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("fails when target content does not exist and leaves the file untouched", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-patch-miss-"));
      try {
        const original = "const a = 1;\nconst b = 2;\n";
        const filePath = join(root, "test.ts");
        writeFileSync(filePath, original, "utf8");

        const res = handlePatchFile({
          path: "test.ts",
          target_content: "const nonexistent = 999;",
          replacement_content: "",
          cwd: root,
          roots: [root],
        });
        expect(res.isError).toBe(true);
        expect(payload(res).error).toContain("target_content was not found");
        expect(readFileSync(filePath, "utf8")).toBe(original);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects binary files instead of corrupting them", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-patch-binary-"));
      try {
        const filePath = join(root, "blob.bin");
        writeFileSync(filePath, Buffer.from([0x48, 0x65, 0x00, 0x6c, 0x6c, 0x6f]), "binary");

        const res = handlePatchFile({
          path: "blob.bin",
          target_content: "He",
          replacement_content: "BY",
          cwd: root,
          roots: [root],
        });
        expect(res.isError).toBe(true);
        const out = payload(res);
        expect(out.binary).toBe(true);
        expect(out.error).toContain("Binary file");
        expect(out.size_bytes).toBe(6);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("rejects sandbox escapes before any write happens", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-patch-escape-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-patch-outside-"));
      try {
        writeFileSync(join(outsideDir, "target.txt"), "secret");
        expect(() =>
          handlePatchFile({
            path: join(outsideDir, "target.txt"),
            target_content: "secret",
            replacement_content: "hacked",
            cwd: root,
            roots: [root],
          }),
        ).toThrow("outside allowed sandbox roots");
        expect(readFileSync(join(outsideDir, "target.txt"), "utf8")).toBe("secret");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("reports missing files and directories as errors", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-patch-edge-"));
      try {
        const missing = handlePatchFile({ path: "nope.txt", target_content: "a", replacement_content: "b", cwd: root, roots: [root] });
        expect(missing.isError).toBe(true);
        expect(payload(missing).error).toContain("File does not exist");

        mkdirSync(join(root, "folder"));
        const dir = handlePatchFile({ path: "folder", target_content: "a", replacement_content: "b", cwd: root, roots: [root] });
        expect(dir.isError).toBe(true);
        expect(payload(dir).error).toContain("directory");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("size limits", () => {
    test("writes large payloads but codex_read_file refuses files above the read ceiling", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-mutation-size-"));
      try {
        // The write handler has no size guard of its own; the transport-level schema cap is what
        // bounds one codex_write_file call, and the read ceiling is the guard for reading back.
        const oversized = "A".repeat(CHATGPT_WEB_MAX_READ_FILE_BYTES + 1);
        const res = handleWriteFile({ path: "big.log", content: oversized, cwd: root, roots: [root] });
        expect(res.isError).toBeUndefined();
        expect(payload(res).bytes_written).toBe(CHATGPT_WEB_MAX_READ_FILE_BYTES + 1);

        const read = handleReadFile({ path: "big.log", cwd: root, roots: [root] });
        expect(read.isError).toBe(true);
        const out = payload(read);
        expect(out.size_bytes).toBe(CHATGPT_WEB_MAX_READ_FILE_BYTES + 1);
        expect(out.error).toContain("too large to read");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Sprint C: symlinked ancestors for new files (C1) and writableRoots (C2)", () => {
    test("C1: rejects write_file of a new file through a symlinked parent directory", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c1-parent-link-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-c1-outside-"));
      try {
        symlinkSync(outsideDir, join(root, "link"));

        // The leaf does not exist, so verification must fall back to the deepest existing
        // ancestor (the symlinked directory); otherwise writeFileSync would follow the link
        // and create the file outside the sandbox.
        expect(() =>
          handleWriteFile({ path: "link/newfile.txt", content: "escaped", cwd: root, roots: [root] }),
        ).toThrow("outside allowed sandbox roots");
        expect(existsSync(join(outsideDir, "newfile.txt"))).toBe(false);
        expect(existsSync(join(root, "link", "newfile.txt"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("C1: refuses create_parents through a symlinked ancestor and creates nothing outside", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c1-parents-link-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-c1-parents-out-"));
      try {
        symlinkSync(outsideDir, join(root, "link"));

        expect(() =>
          handleWriteFile({
            path: "link/made/up/file.txt",
            content: "x",
            create_parents: true,
            cwd: root,
            roots: [root],
          }),
        ).toThrow("outside allowed sandbox roots");
        expect(existsSync(join(outsideDir, "made"))).toBe(false);
        expect(existsSync(join(root, "link", "made"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("C1: fails closed when the new file path is a dangling symlink pointing outside", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c1-dangling-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-c1-dangling-out-"));
      try {
        // Target does not exist yet: existsSync(leaf) is false, but writeFileSync would still
        // follow the link and create the target outside the sandbox.
        symlinkSync(join(outsideDir, "not-yet.txt"), join(root, "dangling.txt"));

        expect(() =>
          handleWriteFile({ path: "dangling.txt", content: "x", cwd: root, roots: [root] }),
        ).toThrow("Cannot verify symlink safety");
        expect(existsSync(join(outsideDir, "not-yet.txt"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("C1 regression: an existing file behind a symlinked directory stays rejected for patch_file", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c1-patch-link-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "cgw-c1-patch-out-"));
      try {
        writeFileSync(join(outsideDir, "victim.txt"), "secret");
        symlinkSync(outsideDir, join(root, "link"));

        expect(() =>
          handlePatchFile({
            path: "link/victim.txt",
            target_content: "secret",
            replacement_content: "hacked",
            cwd: root,
            roots: [root],
          }),
        ).toThrow("outside allowed sandbox roots");
        expect(readFileSync(join(outsideDir, "victim.txt"), "utf8")).toBe("secret");
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("C2: writableRoots [] (read-only policy) rejects write and patch without touching disk", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c2-readonly-"));
      try {
        writeFileSync(join(root, "existing.txt"), "original");

        const denied = handleWriteFile({ path: "new.txt", content: "x", cwd: root, roots: [root], writableRoots: [] });
        expect(denied.isError).toBe(true);
        expect(payload(denied).error).toContain("read-only");
        expect(existsSync(join(root, "new.txt"))).toBe(false);

        const patchDenied = handlePatchFile({
          path: "existing.txt",
          target_content: "original",
          replacement_content: "mutated",
          cwd: root,
          roots: [root],
          writableRoots: [],
        });
        expect(patchDenied.isError).toBe(true);
        expect(payload(patchDenied).error).toContain("read-only");
        expect(readFileSync(join(root, "existing.txt"), "utf8")).toBe("original");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("C2: writableRoots narrower than roots confines writes to the writable subtree", () => {
      const root = mkdtempSync(join(tmpdir(), "cgw-c2-narrow-"));
      try {
        mkdirSync(join(root, "src"));
        mkdirSync(join(root, "docs"));
        const options = { cwd: root, roots: [root], writableRoots: [join(root, "src")] };

        const inside = handleWriteFile({ ...options, path: "src/inside.txt", content: "ok" });
        expect(inside.isError).toBeUndefined();
        expect(readFileSync(join(root, "src", "inside.txt"), "utf8")).toBe("ok");

        // Inside the read roots but outside the writable roots: rejected for new files...
        expect(() => handleWriteFile({ ...options, path: "docs/outside.txt", content: "x" })).toThrow(
          "outside allowed writable roots",
        );
        expect(existsSync(join(root, "docs", "outside.txt"))).toBe(false);

        // ...and for patches of existing files.
        writeFileSync(join(root, "docs", "existing.txt"), "original");
        expect(() =>
          handlePatchFile({ ...options, path: "docs/existing.txt", target_content: "original", replacement_content: "mutated" }),
        ).toThrow("outside allowed writable roots");
        expect(readFileSync(join(root, "docs", "existing.txt"), "utf8")).toBe("original");

        const patched = handlePatchFile({ ...options, path: "src/inside.txt", target_content: "ok", replacement_content: "ok patched" });
        expect(patched.isError).toBeUndefined();
        expect(readFileSync(join(root, "src", "inside.txt"), "utf8")).toBe("ok patched");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("Prompt contract integration", () => {
    const req = {
      modelId: CHATGPT_WEB_MODEL_ID,
      stream: true,
      options: { reasoning: "high" as const },
      context: {
        systemPrompt: ["preserve-system"],
        messages: [
          { role: "developer" as const, content: "developer instruction", timestamp: 1 },
          { role: "user" as const, content: "refactor repository code", timestamp: 2 },
        ],
      },
    };
    const caps = {
      localToolsEnabled: true,
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: false,
    };

    test("recommends write_file and patch_file in compiled prompts", () => {
      const compiled = compileChatGptWebPrompt(req, caps, "turn_12345678901234567890123456789012");
      expect(compiled.text).toContain("write_file");
      expect(compiled.text).toContain("patch_file");
      expect(compiled.text).toContain("read_file");
      expect(compiled.text).toContain("list_dir");
      expect(compiled.text).toContain("grep");
    });

    test("advertises the exact fast-path signatures matching the registered schemas", () => {
      const compiled = compileChatGptWebPrompt(req, caps, "turn_12345678901234567890123456789012");
      expect(compiled.text).toContain("codex_write_file(path, content, overwrite, create_parents)");
      expect(compiled.text).toContain("codex_patch_file(path, target_content, replacement_content)");
      expect(compiled.text).toContain("codex_read_file(path, offset, limit_lines)");
      expect(compiled.text).toContain("overwrite=true");
    });
  });
});
