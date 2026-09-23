import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHATGPT_WEB_MAX_READ_FILE_BYTES,
  handleGrep,
  handleListDir,
  handleReadFile,
  resolveSafeWorkspacePath,
  type FastPathToolResult,
  type RgExecution,
} from "../src/adapters/chatgpt-web/fast-path-handlers";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";

function payload(res: FastPathToolResult): Record<string, any> {
  return res.structuredContent as Record<string, any>;
}

function rgExecution(partial: Partial<RgExecution>): RgExecution {
  return { status: 0, stdout: "", stderr: "", ...partial };
}

test("resolveSafeWorkspacePath enforces sandbox root boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-sandbox-test-"));
  try {
    const subFile = join(root, "sub", "test.txt");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(subFile, "hello");

    // Relative inside root
    const resolvedRel = resolveSafeWorkspacePath("sub/test.txt", root, [root]);
    expect(resolvedRel).toBe(subFile);

    // Absolute inside root
    const resolvedAbs = resolveSafeWorkspacePath(subFile, root, [root]);
    expect(resolvedAbs).toBe(subFile);

    // Path traversal outside root
    expect(() => resolveSafeWorkspacePath("../outside.txt", root, [root])).toThrow("outside allowed sandbox roots");
    expect(() => resolveSafeWorkspacePath("../../etc/passwd", root, [root])).toThrow("outside allowed sandbox roots");

    // Absolute outside root
    expect(() => resolveSafeWorkspacePath("/etc/passwd", root, [root])).toThrow("outside allowed sandbox roots");

    // Symlink targeting outside root
    const outsideDir = mkdtempSync(join(tmpdir(), "cgw-outside-"));
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const linkPath = join(root, "bad_link.txt");
    try {
      symlinkSync(outsideFile, linkPath);
      expect(() => resolveSafeWorkspacePath("bad_link.txt", root, [root])).toThrow("outside allowed sandbox roots");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSafeWorkspacePath fails closed when realpath cannot verify symlink safety", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-failclosed-test-"));
  try {
    const filePath = join(root, "target.txt");
    writeFileSync(filePath, "data");

    // Simulate an unresolvable path (EACCES/ELOOP/EPERM class): the handler must never accept
    // the path without symlink verification instead of silently skipping the check.
    const errnoError = Object.assign(new Error("EACCES: permission denied, realpath"), { code: "EACCES" });
    expect(() =>
      resolveSafeWorkspacePath("target.txt", root, [root], {
        realpath: () => {
          throw errnoError;
        },
      }),
    ).toThrow("Cannot verify symlink safety for target.txt: EACCES");

    // Non-errno failures also fail closed instead of being swallowed.
    expect(() =>
      resolveSafeWorkspacePath("target.txt", root, [root], {
        realpath: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("Cannot verify symlink safety for target.txt: UNKNOWN");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("handleReadFile", () => {
  test("reads real files with 1-indexed offsets, limits, and pagination metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-read-test-"));
    try {
      const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: content for testing`);
      writeFileSync(join(root, "sample.txt"), lines.join("\n"));

      const page = handleReadFile({
        path: "sample.txt",
        offset: 10,
        limit_lines: 5,
        cwd: root,
        roots: [root],
        cache: new FastPathWorkspaceCache(),
      });
      const out = payload(page);
      expect(page.isError).toBeUndefined();
      expect(out.path).toBe("sample.txt");
      expect(out.start_line).toBe(10);
      expect(out.end_line).toBe(14);
      expect(out.total_lines).toBe(100);
      expect(out.has_more).toBe(true);
      const contentLines = (out.content as string).split("\n");
      expect(contentLines.length).toBe(5);
      expect(contentLines[0]).toBe("Line 10: content for testing");
      expect(contentLines[4]).toBe("Line 14: content for testing");

      // Defaults: offset 1 and limit_lines 500.
      const defaulted = payload(handleReadFile({ path: "sample.txt", cwd: root, roots: [root] }));
      expect(defaulted.start_line).toBe(1);
      expect(defaulted.end_line).toBe(100);
      expect(defaulted.has_more).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects directories, missing files, and binary content", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-read-edge-"));
    try {
      mkdirSync(join(root, "folder"));
      writeFileSync(join(root, "sample.bin"), Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]));

      const dirResult = handleReadFile({ path: "folder", cwd: root, roots: [root] });
      expect(dirResult.isError).toBe(true);
      expect(payload(dirResult).error).toContain("directory");

      const missing = handleReadFile({ path: "nope.txt", cwd: root, roots: [root] });
      expect(missing.isError).toBe(true);
      expect(payload(missing).error).toContain("File does not exist");

      const binary = handleReadFile({ path: "sample.bin", cwd: root, roots: [root] });
      expect(binary.isError).toBe(true);
      expect(payload(binary).binary).toBe(true);
      expect(payload(binary).error).toContain("Binary file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses files above the hard read ceiling before reading them", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-read-ceiling-"));
    try {
      const oversized = Buffer.alloc(CHATGPT_WEB_MAX_READ_FILE_BYTES + 1, 0x41);
      writeFileSync(join(root, "big.log"), oversized);

      const res = handleReadFile({ path: "big.log", cwd: root, roots: [root] });
      expect(res.isError).toBe(true);
      const out = payload(res);
      expect(out.size_bytes).toBe(CHATGPT_WEB_MAX_READ_FILE_BYTES + 1);
      expect(out.error).toContain("too large to read");
      expect(out.suggestion).toContain("offset/limit_lines");
      expect(out.suggestion).toContain("codex_exec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("handleListDir", () => {
  test("excludes ignored top-level directories and they do not consume the limit", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-list-test-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".git"), { recursive: true });
      mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export {}");
      writeFileSync(join(root, ".git", "config"), "[core]");
      writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = {}");
      writeFileSync(join(root, "package.json"), "{}");
      for (const name of ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]) {
        writeFileSync(join(root, name), "x");
      }

      // 6 visible entries (src + package.json + 5 files) against a limit of 6: if the ignored
      // directories were listed first (directories sort before files), e.txt would be missing.
      const res = handleListDir({ path: ".", depth: 1, limit: 6, cwd: root, roots: [root] });
      const out = payload(res);
      const names = (out.entries as Array<{ name: string }>).map(entry => entry.name);
      expect(names).not.toContain(".git");
      expect(names).not.toContain("node_modules");
      expect(names).not.toContain("dist");
      expect(names).toContain("src");
      expect(names).toEqual(["src", "a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
      expect(out.total).toBe(6);
      expect(out.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not descend into ignored directories even with depth available", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-list-depth-"));
    try {
      mkdirSync(join(root, "src", "nested"), { recursive: true });
      mkdirSync(join(root, ".git", "objects"), { recursive: true });
      writeFileSync(join(root, "src", "nested", "deep.ts"), "export {}");
      writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main");

      const res = handleListDir({ path: ".", depth: 3, limit: 100, cwd: root, roots: [root] });
      const paths = (payload(res).entries as Array<{ path: string }>).map(entry => entry.path);
      expect(paths).toContain(join("src", "nested"));
      expect(paths).toContain(join("src", "nested", "deep.ts"));
      expect(paths.some(entryPath => entryPath.startsWith(".git"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects files and missing directories", () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-list-edge-"));
    try {
      writeFileSync(join(root, "file.txt"), "x");

      const fileResult = handleListDir({ path: "file.txt", cwd: root, roots: [root] });
      expect(fileResult.isError).toBe(true);
      expect(payload(fileResult).error).toContain("not a directory");

      const missing = handleListDir({ path: "nope", cwd: root, roots: [root] });
      expect(missing.isError).toBe(true);
      expect(payload(missing).error).toContain("Directory does not exist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("handleGrep", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-grep-test-"));

  test("parses rg stdout lines into file, line, and text matches", () => {
    let capturedArgs: string[] = [];
    let capturedCwd = "";
    const runRg = (_rgPath: string, args: string[], options: { cwd: string }) => {
      capturedArgs = args;
      capturedCwd = options.cwd;
      const longMatch = `const needle = "${"x".repeat(300)}";`;
      return rgExecution({
        status: 0,
        stdout: [
          `${join(root, "a.ts")}:3:const needle = 1;`,
          `${join(root, "b.ts")}:7:needle needle`,
          `${join(root, "c.ts")}:9:${longMatch}`,
        ].join("\n"),
      });
    };

    const res = handleGrep({ query: "needle", max_results: 50, cwd: root, roots: [root], runRg });
    expect(res.isError).toBeUndefined();
    const out = payload(res);
    expect(out.query).toBe("needle");
    expect(out.path).toBe(".");
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(false);
    const matches = out.matches as Array<{ file: string; line: number; text: string }>;
    expect(matches[0]).toEqual({ file: "a.ts", line: 3, text: "const needle = 1;" });
    expect(matches[1].file).toBe("b.ts");
    // Long matched lines are clipped to keep the MCP result small.
    expect(matches[2].text.length).toBe(203);
    expect(matches[2].text.endsWith("...")).toBe(true);

    // Argument plumbing for the spawned ripgrep process.
    expect(capturedArgs).toContain("--line-number");
    expect(capturedArgs).toContain("-i");
    expect(capturedArgs.slice(-3)).toEqual(["-e", "needle", root]);
    expect(capturedArgs.at(-1)).toBe(root);
    expect(capturedCwd).toBe(root);
  });

  test("passes case sensitivity and file pattern flags through to rg", () => {
    let capturedArgs: string[] = [];
    const runRg = (_rgPath: string, args: string[]) => {
      capturedArgs = args;
      return rgExecution({ status: 1 });
    };
    handleGrep({
      query: "Needle",
      case_sensitive: true,
      file_pattern: "*.ts",
      max_results: 7,
      cwd: root,
      roots: [root],
      runRg,
    });
    expect(capturedArgs).not.toContain("-i");
    expect(capturedArgs).toContain("--max-count");
    expect(capturedArgs[capturedArgs.indexOf("--max-count") + 1]).toBe("7");
    // The exclusion globs come first; the user-supplied file pattern glob is the last one.
    expect(capturedArgs[capturedArgs.lastIndexOf("--glob") + 1]).toBe("*.ts");
  });

  test("treats exit code 1 as zero matches, not an error", () => {
    const res = handleGrep({ query: "needle", cwd: root, roots: [root], runRg: () => rgExecution({ status: 1 }) });
    expect(res.isError).toBeUndefined();
    const out = payload(res);
    expect(out.matches).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.truncated).toBe(false);
  });

  test("surfaces nonzero exit codes with stderr instead of masking them as 0 matches", () => {
    // Regression: exit code 2 with empty stdout (invalid pattern, unreadable target) used to be
    // reported as a successful empty search.
    const res = handleGrep({
      query: "([invalid",
      cwd: root,
      roots: [root],
      runRg: () => rgExecution({ status: 2, stderr: "regex parse error: unclosed group" }),
    });
    expect(res.isError).toBe(true);
    const out = payload(res);
    expect(out.error).toContain("exit 2");
    expect(out.error).toContain("regex parse error: unclosed group");
  });

  test("reports spawn failures from the executor", () => {
    const res = handleGrep({
      query: "needle",
      cwd: root,
      roots: [root],
      runRg: () => rgExecution({ status: null, error: new Error("spawn ETIMEDOUT") }),
    });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("rg execution failed");
    expect(payload(res).error).toContain("ETIMEDOUT");
  });

  test("explains a missing ripgrep binary instead of a raw ENOENT", () => {
    const res = handleGrep({
      query: "needle",
      cwd: root,
      roots: [root],
      resolveRgPath: () => null,
      runRg: () => {
        throw new Error("executor must not run without an rg binary");
      },
    });
    expect(res.isError).toBe(true);
    expect(payload(res).error).toContain("ripgrep (rg) is not installed or not on PATH");
  });

  test("rejects search targets outside the sandbox", () => {
    expect(() => handleGrep({ query: "needle", path: "../outside", cwd: root, roots: [root] })).toThrow("outside allowed sandbox roots");
  });
});
