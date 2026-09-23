import { describe, expect, test } from "bun:test";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Sprint P: Workspace Pre-Warming & Import Graph Caching", () => {
  test("prewarms local TypeScript / JavaScript imports on file read", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prewarm-test-"));
    try {
      const helperPath = join(tempDir, "helper.ts");
      const utilsPath = join(tempDir, "utils.js");
      const mainPath = join(tempDir, "main.ts");

      writeFileSync(helperPath, "export function help() { return 'helped'; }");
      writeFileSync(utilsPath, "module.exports = { util: true };");

      const mainContent = `
import { help } from "./helper";
const utils = require("./utils");
export const app = { help, utils };
`;
      writeFileSync(mainPath, mainContent);

      const cache = new FastPathWorkspaceCache();
      const prewarmed = cache.prewarmLocalImports(mainPath, mainContent, [tempDir]);

      expect(prewarmed.length).toBe(2);
      expect(prewarmed).toContain(helperPath);
      expect(prewarmed).toContain(utilsPath);

      // Verify that the prewarmed files are actually cached and can be retrieved with hits
      const helperStat = statSync(helperPath);
      const cachedHelper = cache.get(helperPath, helperStat);
      expect(cachedHelper).not.toBeNull();
      expect(cachedHelper?.text).toContain("helped");

      const utilsStat = statSync(utilsPath);
      const cachedUtils = cache.get(utilsPath, utilsStat);
      expect(cachedUtils).not.toBeNull();
      expect(cachedUtils?.text).toContain("util: true");

      const stats = cache.getStats();
      expect(stats.prewarmedCount).toBe(2);
      expect(stats.hits).toBe(2);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("prewarms local Python imports", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prewarm-py-test-"));
    try {
      const subDir = join(tempDir, "pkg");
      mkdirSync(subDir, { recursive: true });
      const modAPath = join(subDir, "module_a.py");
      const modBPath = join(subDir, "module_b.py");

      writeFileSync(modAPath, "def func_a(): pass");
      const modBContent = `
from .module_a import func_a

def func_b():
    return func_a()
`;
      writeFileSync(modBPath, modBContent);

      const cache = new FastPathWorkspaceCache();
      const prewarmed = cache.prewarmLocalImports(modBPath, modBContent, [tempDir]);

      expect(prewarmed).toContain(modAPath);
      const statA = statSync(modAPath);
      const cachedA = cache.get(modAPath, statA);
      expect(cachedA).not.toBeNull();
      expect(cachedA?.text).toContain("func_a");
      expect(cache.getStats().prewarmedCount).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("respects sandbox roots and ignores specifiers outside allowed roots", () => {
    const rootA = mkdtempSync(join(tmpdir(), "prewarm-rootA-"));
    const rootB = mkdtempSync(join(tmpdir(), "prewarm-rootB-"));
    try {
      const fileInA = join(rootA, "index.ts");
      const fileInB = join(rootB, "secret.ts");
      writeFileSync(fileInB, "export const secret = 42;");

      const content = `import { secret } from "../${join("..", fileInB)}";`;
      writeFileSync(fileInA, content);

      const cache = new FastPathWorkspaceCache();
      // Only rootA is allowed
      const prewarmed = cache.prewarmLocalImports(fileInA, content, [rootA]);
      expect(prewarmed.length).toBe(0);
      expect(cache.getStats().prewarmedCount).toBe(0);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test("skips already cached files without re-reading or incrementing prewarmedCount", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "prewarm-cached-test-"));
    try {
      const helperPath = join(tempDir, "helper.ts");
      const mainPath = join(tempDir, "main.ts");
      writeFileSync(helperPath, "export const value = 1;");
      const mainContent = 'import { value } from "./helper";';
      writeFileSync(mainPath, mainContent);

      const cache = new FastPathWorkspaceCache();
      // First prewarm
      const first = cache.prewarmLocalImports(mainPath, mainContent, [tempDir]);
      expect(first.length).toBe(1);
      expect(cache.getStats().prewarmedCount).toBe(1);

      // Second prewarm on same file
      const second = cache.prewarmLocalImports(mainPath, mainContent, [tempDir]);
      expect(second.length).toBe(0);
      expect(cache.getStats().prewarmedCount).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
