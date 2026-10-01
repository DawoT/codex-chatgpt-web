import { expect, test } from "bun:test";
import { truncateOversizedContextForFallbackCompaction } from "../src/adapters/chatgpt-web/adapter/compaction-flow";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { compileChatGptWebPrompt, withoutRetiredTurnHandles } from "../src/adapters/chatgpt-web/prompt";
import { normalizeCompactionStateBlock } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const handle = `turn_${"a".repeat(32)}`;

test("normalization preserves quoted values and inline/fenced code literally and is idempotent", () => {
  const quoted = String.raw`"src/my\_file.ts next_actions: - keep"`;
  const inline = String.raw`\`const next_actions = "a\_b"; - keep\``;
  const fenced = '```js\nconst next_actions = "a\\_b";\n- keep\n```';
  const raw = `<compaction_state> version: 2 modified\\_files: - ${quoted}\nactive_hypothesis: ${inline}\n${fenced}\nnext\\_actions: - Check source </compaction_state>`;
  const normalized = normalizeCompactionStateBlock(raw);
  expect(normalized).toContain(quoted);
  expect(normalized).toContain(inline);
  expect(normalized).toContain(fenced);
  expect(normalized).toContain("modified_files:");
  expect(normalized).toContain("next_actions:");
  expect(normalizeCompactionStateBlock(normalized)).toBe(normalized);
});

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      systemPrompt: ["Preserve exact data"],
      messages: [{ role: "user", content: `const handle = "${handle}";`, timestamp: 1 }],
    },
    options: { reasoning: "medium" },
  };
}

test("handle retirement is restricted to broker metadata and preserves all task literals", () => {
  const data = {
    content: `const handle = "${handle}";`,
    tool_call_id: handle,
    broker_metadata: { turn_token: handle },
  };
  const result = JSON.parse(withoutRetiredTurnHandles(JSON.stringify(data)));
  expect(result.content).toBe(data.content);
  expect(result.tool_call_id).toBe(handle);
  expect(result.broker_metadata.turn_token).toBe("[retired turn handle]");
  const compiled = compileChatGptWebPrompt(
    request(),
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    "turn_current",
  );
  expect(compiled.text).toContain(handle);
});

test("fallback preserves complete system and user records before transport preflight", () => {
  const parsed = request();
  parsed.context.systemPrompt = ["system_".repeat(40_000)];
  parsed.context.messages[0]!.content = "user_".repeat(50_000);
  const selected = truncateOversizedContextForFallbackCompaction(parsed);
  expect(selected.context.systemPrompt).toEqual(parsed.context.systemPrompt);
  expect(selected.context.messages).toEqual(parsed.context.messages);
});

test("compilation manifest binds fidelity hashes and measurement reuse to the selected payload", async () => {
  const { measureCompiledBrowserPayload, measureCompiledChatGptWebInput } = await import(
    "../src/adapters/chatgpt-web/input-tokens"
  );
  const { createHash } = await import("node:crypto");
  const parsed = request();
  const compiled = compileChatGptWebPrompt(
    parsed,
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    "turn_current",
  );
  expect(compiled.compilation?.sourceSha256).toBe(
    createHash("sha256").update(JSON.stringify(parsed.context)).digest("hex"),
  );
  expect(compiled.compilation?.payloadSha256).toBe(createHash("sha256").update(compiled.text).digest("hex"));
  expect(compiled.compilation?.sections.taskContextSha256).toBeTypeOf("string");
  const measurement = measureCompiledBrowserPayload(compiled, parsed.modelId);
  expect(compiled.compilation?.measurement).toBe(measurement);
  expect(measureCompiledBrowserPayload(compiled, parsed.modelId)).toBe(measurement);
  expect(measureCompiledChatGptWebInput(compiled, parsed.modelId)).toBe(
    measureCompiledChatGptWebInput(compiled, parsed.modelId),
  );
  compiled.text += "changed";
  const updated = measureCompiledBrowserPayload(compiled, parsed.modelId);
  expect(updated).not.toBe(measurement);
  expect(updated.messageBytes[0]).toBe(measurement.messageBytes[0]! + 7);
});

test("one checkpoint policy exposes missing fields and never auto-invents requirements", async () => {
  const { inspectCompactionCheckpoint, CompactionCheckpointPolicy } = await import(
    "../src/adapters/chatgpt-web/compaction-policy"
  );
  const parsed = request();
  parsed._compactionRequest = true;
  parsed._rawBody = {
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: parsed.context.messages[0]!.content }],
        internal_chat_message_metadata_passthrough: { turn_id: "source" },
      },
    ],
  };
  const draft = "<compaction_state>\nversion: 2\nnext_actions:\n- Inspect src/app.ts\n</compaction_state>";
  const inspected = inspectCompactionCheckpoint(parsed, draft);
  expect(inspected.valid).toBe(false);
  expect(inspected.issues.length).toBeGreaterThan(0);
  expect(inspected.summary).not.toContain("requirements:");
  expect(inspectCompactionCheckpoint(parsed, inspected.summary).summary).toBe(inspected.summary);
  let repairs = 0;
  const repaired = await new CompactionCheckpointPolicy(parsed).repair(draft, async (issues) => {
    expect(issues.length).toBeGreaterThan(0);
    repairs += 1;
    return draft;
  });
  expect(repaired.valid).toBe(false);
  expect(repairs).toBe(1);
  const freeform = inspectCompactionCheckpoint(
    parsed,
    "Task still open; inspect source and run its tests before claiming success.",
  );
  expect(freeform.valid).toBe(false);
  expect(freeform.summary).not.toContain("requirements:");
});

test("instruction selection preserves literal user/system/developer text in every mode", () => {
  const parsed = request();
  parsed.context.systemPrompt = ["You are Codex. Preserve the important constraint."];
  parsed.context.messages = [
    { role: "developer", content: "You are Codex. Never discard evidence.", timestamp: 1 },
    {
      role: "user",
      content: "# AGENTS.md instructions\n<INSTRUCTIONS>Keep every constraint</INSTRUCTIONS>",
      timestamp: 2,
    },
    {
      role: "user",
      content: "Explain the literal <skills_instructions>example</skills_instructions> text.",
      timestamp: 3,
    },
  ];
  for (const conversationalFreedom of [true, false]) {
    const result = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
      "turn_current",
      { conversationalFreedom },
    );
    const envelope = JSON.parse(result.text.split("<codex_context_json>\n")[1]!.split("\n</codex_context_json>")[0]!);
    expect(envelope.system).toEqual(parsed.context.systemPrompt);
    expect(envelope.messages.map((message: { content: string }) => message.content)).toEqual(
      parsed.context.messages.map((message) => message.content),
    );
  }
});

test("lookalike developer contracts survive unless replacement provenance is explicit", async () => {
  const { withoutSupersededModelSwitchContracts } = await import("../src/adapters/chatgpt-web/prompt");
  const history = [
    { role: "developer" as const, content: "<model_switch>first requirement</model_switch>", timestamp: 1 },
    { role: "developer" as const, content: "<model_switch>second requirement</model_switch>", timestamp: 2 },
  ];
  expect(withoutSupersededModelSwitchContracts(history)).toEqual(history);
});

test("large malformed checkpoint normalization remains bounded", () => {
  const script = [
    'import { normalizeCompactionStateBlock } from "./src/responses/compaction.ts";',
    'const raw = "<compaction_state>\\n" + "A".repeat(560_000) + "\\n</compaction_state>";',
    "const normalized = normalizeCompactionStateBlock(raw);",
    'if (!normalized.includes("A".repeat(560_000))) process.exit(1);',
  ].join("\n");
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    cwd: process.cwd(),
    timeout: 1500,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
});
