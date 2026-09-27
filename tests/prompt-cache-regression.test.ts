import { expect, test } from "bun:test";
import { PromptContractCache } from "../src/adapters/chatgpt-web/prompt-cache";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const token = `turn_${"7".repeat(32)}`;

function request(name: string, strict: boolean): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: { systemPrompt: [], messages: [{ role: "user", content: "Return the result", timestamp: 1 }] },
    stream: true,
    options: { reasoning: "high", outputFormat: { type: "json_schema", name, strict, schema: { type: "object" } } },
  };
}

test("cached prompt keeps each request's schema name and strictness", () => {
  compileChatGptWebPrompt(request("previous", false), capabilities, token);
  const compiled = compileChatGptWebPrompt(request("current", true), capabilities, token);
  expect(compiled.text).toContain('strict JSON-schema final answer named "current"');
  expect(compiled.text).not.toContain('named "previous"');
});

test("continuation preserves requested output schema", () => {
  const compiled = compileChatGptWebPrompt(request("continued", true), capabilities, token, { continuation: true });
  expect(compiled.text).toContain('strict JSON-schema final answer named "continued"');
  expect(compiled.text).toContain('<codex_output_schema_json>');
});

test("updating an existing cache entry preserves other entries", () => {
  const cache = new PromptContractCache(2);
  cache.set("a", ["first"]);
  cache.set("b", ["second"]);
  cache.set("b", ["updated"]);
  expect(cache.get("a")).toEqual(["first"]);
  expect(cache.get("b")).toEqual(["updated"]);
});

test("invalid cache capacities fail explicitly", () => {
  for (const capacity of [NaN, Infinity, -1, 0, 1.5]) {
    expect(() => new PromptContractCache(capacity)).toThrow(RangeError);
  }
});

test("read-only continuation does not advertise local tools", () => {
  const compiled = compileChatGptWebPrompt(
    request("read_only", true),
    { ...capabilities, localToolsEnabled: false },
    undefined,
    { continuation: true },
  );
  expect(compiled.text).toContain("no Codex Native bridge");
  expect(compiled.text).not.toContain("use the attached Codex Native tools");
  expect(compiled.text).toContain('strict JSON-schema final answer named "read_only"');
});
