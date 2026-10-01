import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { measureCompiledBrowserPayload } from "../src/adapters/chatgpt-web/input-tokens";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import type { CodexParsedRequest } from "../src/types";
import { sourceRevision } from "./check-harness-continuity";

const baselineArg = process.argv.find((argument) => argument.startsWith("--baseline-root="));
assert(baselineArg, "Provide --baseline-root=/absolute/path/to/verified-baseline-worktree");
const baselineRoot = resolve(baselineArg.slice(16));
const candidateRevisionBefore = await sourceRevision();
const baselineCompiler = await import(
  pathToFileURL(resolve(baselineRoot, "src/adapters/chatgpt-web/prompt/compiler.ts")).href
);
const baselineTokens = await import(
  pathToFileURL(resolve(baselineRoot, "src/adapters/chatgpt-web/input-tokens.ts")).href
);
const capabilities = {
  localToolsEnabled: true,
  solAvailable: true,
  extraHighAvailable: true,
  proAvailable: true,
};
const handle = `turn_${"a".repeat(32)}`;
const scenarios = [
  {
    name: "literal-code-and-identifiers",
    system: "Keep quoted literals exactly.",
    developer: "Use the provided repository conventions.",
    user: `Fix src/my_file.ts. Preserve const id = "${handle}"; and String.raw\`a\\_b\`. Run the regression tests.`,
    multipart: false,
  },
  {
    name: "priority-and-repository-instructions",
    system: "You are Codex. Keep the existing public API and verify real tool results.",
    developer:
      "# AGENTS.md instructions\n<INSTRUCTIONS>\nDo not deploy. Preserve requirement REQ-007.\n</INSTRUCTIONS>",
    user: "Continue the coding task, preserving REQ-007 and its pending verification.",
    multipart: false,
  },
  {
    name: "literal-skill-instructions",
    system: "Keep all supplied instructions.",
    developer:
      "<skills_instructions>\n<skill>\n<name>review</name>\n<description>Repository review</description>\n<location>.agents/skills/review/SKILL.md</location>\nInspect changes and preserve the evidence.\n</skill>\n</skills_instructions>",
    user: "Review the implementation and execute the required checks.",
    multipart: false,
  },
  {
    name: "multipart-coding-evidence",
    system: "Preserve all evidence and pending obligations.",
    developer: "Keep tool identifiers and paths unchanged.",
    user: `Continue from ${handle}.\n${"Observed tool result: test passed; src/my_file.ts remains pending review.\n".repeat(300)}`,
    multipart: true,
  },
];

function measure(
  scenario: (typeof scenarios)[number],
  compile: typeof compileChatGptWebPrompt,
  metrics: typeof measureCompiledBrowserPayload,
) {
  const parsed: CodexParsedRequest = {
    modelId: "gpt-5.6-sol",
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: [scenario.system],
      messages: [
        { role: "developer", content: scenario.developer, timestamp: 1 },
        { role: "user", content: scenario.user, timestamp: 2 },
      ],
    },
  };
  const samplesMs: number[] = [];
  let compiled: ReturnType<typeof compile> | undefined;
  let payload: ReturnType<typeof metrics> | undefined;
  for (let sample = 0; sample < 5; sample += 1) {
    const started = performance.now();
    compiled = compile(parsed, capabilities, "turn_current", {
      conversationalFreedom: true,
      ...(scenario.multipart ? { experimentalMultipartParts: 6 } : {}),
    });
    payload = metrics(compiled, parsed.modelId);
    samplesMs.push(performance.now() - started);
  }
  assert(compiled && payload);
  const wire = compiled.multipart ? compiled.multipart.parts.join("\n") : compiled.text;
  const fidelity = [scenario.system, scenario.developer, scenario.user].map((literal) =>
    wire.includes(JSON.stringify(literal).slice(1, -1)),
  );
  const ordered = [...samplesMs].sort((left, right) => left - right);
  return {
    fidelity,
    allInstructionsAndTaskPreserved: fidelity.every(Boolean),
    tokensEstimated: payload.messageTokensEstimated.reduce((sum, value) => sum + value, 0),
    bytes: payload.messageBytes.reduce((sum, value) => sum + value, 0),
    samplesMs,
    p50Ms: ordered[2],
    p95Ms: ordered[4],
    payloadSha256: createHash("sha256").update(wire).digest("hex"),
  };
}

const results = scenarios.map((scenario) => {
  const baseline = measure(
    scenario,
    baselineCompiler.compileChatGptWebPrompt,
    baselineTokens.measureCompiledBrowserPayload,
  );
  const candidate = measure(scenario, compileChatGptWebPrompt, measureCompiledBrowserPayload);
  assert(candidate.allInstructionsAndTaskPreserved, `Candidate lost literal data in ${scenario.name}`);
  return {
    name: scenario.name,
    baseline,
    candidate,
    delta: {
      tokensEstimated: candidate.tokensEstimated - baseline.tokensEstimated,
      bytes: candidate.bytes - baseline.bytes,
      p50Ms: candidate.p50Ms! - baseline.p50Ms!,
      p95Ms: candidate.p95Ms! - baseline.p95Ms!,
    },
  };
});
const baselineRevision = Bun.spawnSync(["git", "-C", baselineRoot, "rev-parse", "HEAD"]);
assert.equal(baselineRevision.exitCode, 0);
const candidateRevision = await sourceRevision();
assert.deepEqual(candidateRevision, candidateRevisionBefore, "Candidate changed during measurement");
process.stdout.write(
  `${JSON.stringify(
    {
      scope: "Local compiler plus transport measurement; no model execution or live browser latency",
      baselineCommit: baselineRevision.stdout.toString().trim(),
      candidateRevision,
      runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
      scenarioSha256: createHash("sha256").update(JSON.stringify(scenarios)).digest("hex"),
      sampleCount: 5,
      percentileMethod: "nearest-rank, including first sample",
      results,
    },
    null,
    2,
  )}\n`,
);
