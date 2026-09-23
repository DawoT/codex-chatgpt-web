import { describe, expect, test } from "bun:test";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  inferAdaptiveReasoningEffort,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
} from "../src/adapters/chatgpt-web/model";

describe("Sprint R: Dynamic Reasoning Effort Adaptation", () => {
  const capabilities: ChatGptWebCapabilities = {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: true,
    proAvailable: true,
  };

  test("preserves explicit reasoning effort verbatim", () => {
    const modeLow = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities);
    expect(modeLow.effort).toBe("low");
    expect(modeLow.displayLabel).toBe("Instant");

    const modeHigh = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", capabilities);
    expect(modeHigh.effort).toBe("high");
    expect(modeHigh.displayLabel).toBe("High");
  });

  test("adapts to high reasoning effort on test failures or errors in context", () => {
    const errorContext = {
      messages: [
        { role: "user", content: "Check the test status." },
        {
          role: "assistant",
          content: [{ type: "text", text: "Running bun test\nFAIL tests/auth.test.ts > 1 tests failed: TypeError: undefined is not an object\nexit status 1" }],
        },
        { role: "user", content: "Fix the failure." },
      ],
    };

    const inferred = inferAdaptiveReasoningEffort(errorContext);
    expect(inferred).toBe("high");

    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, undefined, capabilities, errorContext);
    expect(mode.effort).toBe("high");
    expect(mode.displayLabel).toBe("High");
  });

  test("adapts to high reasoning effort on deep refactoring or concurrency tasks", () => {
    const refactorContext = {
      messages: [
        { role: "user", content: "Refactor the concurrency queue to prevent race conditions and deadlocks." },
      ],
    };

    const inferred = inferAdaptiveReasoningEffort(refactorContext);
    expect(inferred).toBe("high");

    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, undefined, capabilities, refactorContext);
    expect(mode.effort).toBe("high");
  });

  test("adapts to low reasoning effort for simple directory discovery or status checks", () => {
    const discoveryContext = {
      messages: [
        { role: "user", content: "list files in src" },
      ],
    };

    const inferred = inferAdaptiveReasoningEffort(discoveryContext);
    expect(inferred).toBe("low");

    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, undefined, capabilities, discoveryContext);
    expect(mode.effort).toBe("low");
    expect(mode.displayLabel).toBe("Instant");
  });

  test("adapts to medium effort on compaction requests", () => {
    const compactionContext = {
      compactionRequest: true,
      messages: [{ role: "user", content: "Perform checkpoint compaction." }],
    };

    const inferred = inferAdaptiveReasoningEffort(compactionContext);
    expect(inferred).toBe("medium");

    const mode = resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, undefined, capabilities, compactionContext);
    expect(mode.effort).toBe("medium");
    expect(mode.displayLabel).toBe("Medium");
  });

  test("adapts Luna effort between low and medium (Think)", () => {
    const lunaCapabilities: ChatGptWebCapabilities = {
      localToolsEnabled: true,
      solAvailable: false,
      extraHighAvailable: false,
      proAvailable: false,
    };

    const discoveryContext = { messages: [{ role: "user", content: "list files" }] };
    const lunaDiscovery = resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, undefined, lunaCapabilities, discoveryContext);
    expect(lunaDiscovery.effort).toBe("low");
    expect(lunaDiscovery.thinkEnabled).toBe(false);

    const complexContext = { messages: [{ role: "user", content: "FAIL in tests! Fix error: TypeError" }] };
    const lunaComplex = resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, undefined, lunaCapabilities, complexContext);
    expect(lunaComplex.effort).toBe("medium");
    expect(lunaComplex.thinkEnabled).toBe(true);
    expect(lunaComplex.displayLabel).toBe("Think");
  });
});
