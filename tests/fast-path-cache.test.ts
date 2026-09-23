import { describe, expect, test } from "bun:test";
import { FastPathWorkspaceCache } from "../src/adapters/chatgpt-web/fast-path-cache";

describe("Sprint N: In-Memory Fast-Path Workspace Cache with mtime invalidation", () => {
  test("caches file content and serves hits when mtime and size match", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    const resolved = "/workspace/project/src/index.ts";
    const stat = { mtimeMs: 1700000000000, size: 120 };
    const data = {
      text: "export const greeting = 'hello world';",
      lines: ["export const greeting = 'hello world';"],
      isBinary: false,
    };

    // First lookup is a miss
    expect(cache.get(resolved, stat)).toBeNull();

    // Store in cache
    cache.set(resolved, stat, data);

    // Second lookup is a hit
    const cached = cache.get(resolved, stat);
    expect(cached).not.toBeNull();
    expect(cached?.text).toBe(data.text);
    expect(cached?.lines).toEqual(data.lines);
    expect(cached?.totalLines).toBe(1);
    expect(cached?.isBinary).toBe(false);

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.entryCount).toBe(1);
  });

  test("invalidates cache entry when mtime changes on disk", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    const resolved = "/workspace/project/package.json";
    const initialStat = { mtimeMs: 1700000000000, size: 50 };
    cache.set(resolved, initialStat, {
      text: '{"name": "my-app"}',
      lines: ['{"name": "my-app"}'],
      isBinary: false,
    });

    // Modified mtime on disk
    const modifiedStat = { mtimeMs: 1700000005000, size: 50 };
    const cached = cache.get(resolved, modifiedStat);
    expect(cached).toBeNull();

    // Cache entry is pruned
    const stats = cache.getStats();
    expect(stats.entryCount).toBe(0);
    expect(stats.misses).toBe(1);
  });

  test("invalidates cache entry when size changes on disk", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    const resolved = "/workspace/project/package.json";
    const initialStat = { mtimeMs: 1700000000000, size: 50 };
    cache.set(resolved, initialStat, {
      text: '{"name": "my-app"}',
      lines: ['{"name": "my-app"}'],
      isBinary: false,
    });

    // Modified size on disk
    const modifiedStat = { mtimeMs: 1700000000000, size: 100 };
    const cached = cache.get(resolved, modifiedStat);
    expect(cached).toBeNull();
    expect(cache.getStats().entryCount).toBe(0);
  });

  test("explicit invalidate removes the target file entry", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    const pathA = "/workspace/fileA.ts";
    const pathB = "/workspace/fileB.ts";
    cache.set(pathA, { mtimeMs: 1000, size: 10 }, { text: "A", lines: ["A"], isBinary: false });
    cache.set(pathB, { mtimeMs: 1000, size: 10 }, { text: "B", lines: ["B"], isBinary: false });

    expect(cache.invalidate(pathA)).toBe(true);
    expect(cache.invalidate(pathA)).toBe(false); // already gone

    expect(cache.get(pathA, { mtimeMs: 1000, size: 10 })).toBeNull();
    expect(cache.get(pathB, { mtimeMs: 1000, size: 10 })).not.toBeNull();
  });

  test("invalidatePrefix purges all entries under a directory", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    cache.set("/workspace/src/a.ts", { mtimeMs: 1000, size: 10 }, { text: "a", lines: ["a"], isBinary: false });
    cache.set("/workspace/src/sub/b.ts", { mtimeMs: 1000, size: 10 }, { text: "b", lines: ["b"], isBinary: false });
    cache.set("/workspace/tests/a.test.ts", { mtimeMs: 1000, size: 10 }, { text: "test", lines: ["test"], isBinary: false });

    const purged = cache.invalidatePrefix("/workspace/src");
    expect(purged).toBe(2);

    expect(cache.get("/workspace/src/a.ts", { mtimeMs: 1000, size: 10 })).toBeNull();
    expect(cache.get("/workspace/src/sub/b.ts", { mtimeMs: 1000, size: 10 })).toBeNull();
    expect(cache.get("/workspace/tests/a.test.ts", { mtimeMs: 1000, size: 10 })).not.toBeNull();
  });

  test("LRU eviction preserves memory ceiling", () => {
    // 1MB capacity
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    // Fill with entries
    for (let i = 0; i < 50; i++) {
      cache.set(
        `/workspace/file_${i}.txt`,
        { mtimeMs: 1000 + i, size: 1000 },
        { text: "x".repeat(1000), lines: ["x".repeat(1000)], isBinary: false },
      );
    }
    const stats = cache.getStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(stats.entryCount).toBeGreaterThan(0);
  });

  test("caches binary file sentinel without bloating memory", () => {
    const cache = new FastPathWorkspaceCache(1024 * 1024);
    const resolved = "/workspace/assets/logo.png";
    const stat = { mtimeMs: 2000, size: 500_000 };
    cache.set(resolved, stat, { text: "", lines: [], isBinary: true });

    const cached = cache.get(resolved, stat);
    expect(cached).not.toBeNull();
    expect(cached?.isBinary).toBe(true);
    expect(cached?.lines.length).toBe(0);
  });
});
