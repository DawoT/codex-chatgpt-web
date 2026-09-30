import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";

describe("ChatGptThreadEnvironmentStore resilience", () => {
  test("recovers gracefully when thread-environments.json is an empty object {}", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-env-resilience-"));
    const path = join(dir, "thread-environments.json");
    try {
      writeFileSync(path, "{}", "utf8");
      // Must not throw "Invalid ChatGPT thread environment store"
      const store = new ChatGptThreadEnvironmentStore(path);
      // Calling a method triggers load()
      expect(() => (store as unknown as { load: () => void }).load()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resets and self-heals when thread-environments.json has invalid schema or version", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-env-resilience-"));
    const path = join(dir, "thread-environments.json");
    try {
      writeFileSync(path, JSON.stringify({ version: 999, invalid: true }), "utf8");
      const store = new ChatGptThreadEnvironmentStore(path);
      // Must self-heal rather than crash the turn stream
      expect(() => (store as unknown as { load: () => void }).load()).not.toThrow();
      const content = JSON.parse(readFileSync(path, "utf8"));
      expect(content.version).toBe(1);
      expect(content.threads).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resets and self-heals when thread-environments.json contains corrupted JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "thread-env-resilience-"));
    const path = join(dir, "thread-environments.json");
    try {
      writeFileSync(path, "{ corrupted json ...", "utf8");
      const store = new ChatGptThreadEnvironmentStore(path);
      expect(() => (store as unknown as { load: () => void }).load()).not.toThrow();
      const content = JSON.parse(readFileSync(path, "utf8"));
      expect(content.version).toBe(1);
      expect(content.threads).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
