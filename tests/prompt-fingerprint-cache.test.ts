import { beforeEach, describe, expect, test } from "bun:test";
import {
  PromptContractCache,
  defaultPromptContractCache,
  type PromptContractFingerprintInput,
} from "../src/adapters/chatgpt-web/prompt-cache";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

describe("Sprint H: Conversation State Fingerprinting & LRU Prompt Assembly Caching", () => {
  beforeEach(() => {
    defaultPromptContractCache.clear();
  });

  describe("PromptContractCache unit logic", () => {
    test("computes deterministic fingerprints for identical inputs", () => {
      const cache = new PromptContractCache(4);
      const input: PromptContractFingerprintInput = {
        modelId: "gpt-5.6-turbo",
        modeLabel: "High",
        modeEffort: "high",
        localTools: true,
        isSubagent: false,
        verbosity: "medium",
      };

      const fp1 = cache.computeFingerprint(input);
      const fp2 = cache.computeFingerprint({ ...input });
      expect(fp1).toBe(fp2);
      expect(fp1.length).toBe(16);
    });

    test("produces different fingerprints when parameters vary", () => {
      const cache = new PromptContractCache(4);
      const base: PromptContractFingerprintInput = {
        modelId: "gpt-5.6-turbo",
        modeLabel: "High",
        modeEffort: "high",
        localTools: true,
        isSubagent: false,
      };

      const baseFp = cache.computeFingerprint(base);
      const subagentFp = cache.computeFingerprint({ ...base, isSubagent: true });
      const verbosityFp = cache.computeFingerprint({ ...base, verbosity: "low" });
      const manualFp = cache.computeFingerprint({ ...base, manualControl: true });
      const readOnlyFp = cache.computeFingerprint({ ...base, localTools: false });

      expect(baseFp).not.toBe(subagentFp);
      expect(baseFp).not.toBe(verbosityFp);
      expect(baseFp).not.toBe(manualFp);
      expect(baseFp).not.toBe(readOnlyFp);
    });

    test("records hits, misses, and calculates hit ratio accurately", () => {
      const cache = new PromptContractCache(4);
      expect(cache.get("missing_key")).toBeUndefined();

      cache.set("k1", ["contract-1", "contract-2"]);
      const hit1 = cache.get("k1");
      expect(hit1).toEqual(["contract-1", "contract-2"]);

      const hit2 = cache.get("k1");
      expect(hit2).toEqual(["contract-1", "contract-2"]);

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
      expect(stats.capacity).toBe(4);
      expect(stats.hitRatio).toBe(0.667);
    });

    test("evicts least recently used items when exceeding capacity", () => {
      const cache = new PromptContractCache(3);
      cache.set("k1", ["c1"]);
      cache.set("k2", ["c2"]);
      cache.set("k3", ["c3"]);

      // Access k1 to make it most recently used; k2 is now oldest
      cache.get("k1");

      // Insert k4, should evict k2
      cache.set("k4", ["c4"]);

      expect(cache.get("k1")).toBeDefined();
      expect(cache.get("k3")).toBeDefined();
      expect(cache.get("k4")).toBeDefined();
      // k2 should have been evicted
      expect(cache.getStats().size).toBe(3);
    });

    test("records compilation duration and calculates average", () => {
      const cache = new PromptContractCache(4);
      cache.recordCompilation(10);
      cache.recordCompilation(20);

      const stats = cache.getStats();
      expect(stats.totalCompilations).toBe(2);
      expect(stats.avgCompilationTimeMs).toBe(15);
    });

    test("clear resets both storage and metrics", () => {
      const cache = new PromptContractCache(4);
      cache.set("k1", ["c1"]);
      cache.get("k1");
      cache.recordCompilation(5);

      cache.clear();
      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.totalCompilations).toBe(0);
    });
  });

  describe("Integration with compileChatGptWebPrompt", () => {
    test("first compilation registers cache miss and second registers hit with parity", () => {
      const caps = {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: false,
      };

      const req = {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" as const },
        context: {
          systemPrompt: ["system"],
          messages: [
            { role: "user" as const, content: "Initial prompt", timestamp: 1 },
          ],
        },
      };

      defaultPromptContractCache.clear();

      // First compilation (cache miss)
      const compiled1 = compileChatGptWebPrompt(req, caps, "turn_12345678901234567890123456789012");
      const statsAfterFirst = defaultPromptContractCache.getStats();
      expect(statsAfterFirst.misses).toBe(1);
      expect(statsAfterFirst.hits).toBe(0);
      expect(statsAfterFirst.size).toBe(1);

      // Second compilation with same contract settings (cache hit)
      const compiled2 = compileChatGptWebPrompt(req, caps, "turn_12345678901234567890123456789012");
      const statsAfterSecond = defaultPromptContractCache.getStats();
      expect(statsAfterSecond.hits).toBe(1);
      expect(statsAfterSecond.misses).toBe(1);

      // Parity check: prompt text must be identical
      expect(compiled1.text).toBe(compiled2.text);
    });

    test("subagent turn creates a separate cache entry from root turn", () => {
      const caps = {
        localToolsEnabled: true,
        solAvailable: true,
        extraHighAvailable: true,
        proAvailable: false,
      };

      const rootReq = {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" as const },
        context: {
          systemPrompt: ["system"],
          messages: [{ role: "user" as const, content: "Root task", timestamp: 1 }],
        },
      };

      const subagentReq = {
        modelId: CHATGPT_WEB_MODEL_ID,
        stream: true,
        options: { reasoning: "high" as const },
        context: {
          systemPrompt: ["system"],
          messages: [{ role: "user" as const, content: "Subtask", timestamp: 1 }],
        },
        _rawBody: {
          client_metadata: {
            "x-codex-turn-metadata": {
              subagent_kind: "thread_spawn",
              parent_thread_id: "root_1",
            },
          },
        },
      };

      defaultPromptContractCache.clear();

      compileChatGptWebPrompt(rootReq, caps, "turn_12345678901234567890123456789012");
      compileChatGptWebPrompt(subagentReq, caps, "turn_12345678901234567890123456789012");

      const stats = defaultPromptContractCache.getStats();
      expect(stats.size).toBe(2);
      expect(stats.misses).toBe(2);

      // Second run for subagent hits cache
      compileChatGptWebPrompt(subagentReq, caps, "turn_12345678901234567890123456789012");
      expect(defaultPromptContractCache.getStats().hits).toBe(1);
    });
  });
});
