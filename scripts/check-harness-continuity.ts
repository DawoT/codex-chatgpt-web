import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright-core";
import {
  browserScenarios,
  replayScenarioDigest,
  resolveReplayBrowser,
  runBrowserReplay,
  runCodingReplay,
} from "../tests/fixtures/continuity-replay";

const root = resolve(import.meta.dir, "..");
const suites = [
  "tests/browser-worker-contract.test.ts",
  "tests/harness-continuity-lifecycle.test.ts",
  "tests/harness-continuity-browser.test.ts",
  "tests/browser-dom-events.test.ts",
  "tests/harness-continuity-fidelity.test.ts",
  "tests/harness-continuity-telemetry.test.ts",
  "tests/harness-continuity-replay.test.ts",
  "tests/compaction-checkpoint.test.ts",
  "tests/compaction-canary-report.test.ts",
  "tests/rolling-checkpoint.test.ts",
  "tests/turn-events.test.ts",
  "tests/mcp-observation.test.ts",
];

export function summarizeLatencies(samples: number[]) {
  assert(samples.length > 0, "Latency statistics require real samples");
  assert(samples.every((sample) => Number.isFinite(sample) && sample >= 0));
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    samplesMs: samples,
    sampleCount: samples.length,
    p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1]!,
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!,
    method: "nearest-rank" as const,
  };
}

async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${stderr}`);
  }
  return stdout.trim();
}

export async function sourceRevision() {
  const head = await git(["rev-parse", "HEAD"]);
  const diff = await git(["diff", "HEAD", "--", "src"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "src"]);
  const digest = createHash("sha256").update(head).update(diff);
  for (const path of untracked.split("\n").filter(Boolean).sort()) {
    digest.update(path).update(readFileSync(join(root, path)));
  }
  return { head, dirty: Boolean(diff || untracked), sourceDigest: digest.digest("hex") };
}

async function buildValidation() {
  const bundles = [];
  for (const [name, entrypoint, target, format] of [
    ["cli", "src/cli.ts", "bun", "esm"],
    ["browser-helper", "src/adapters/chatgpt-web/browser-helper-main.ts", "node", "cjs"],
  ] as const) {
    const started = performance.now();
    const result = await Bun.build({
      entrypoints: [join(root, entrypoint)],
      target,
      format,
      packages: "external",
      minify: false,
    });
    if (!result.success) {
      throw new Error(`${name} build failed: ${result.logs.map((log) => log.message).join("; ")}`);
    }
    const digest = createHash("sha256");
    let bytes = 0;
    for (const output of result.outputs) {
      const content = new Uint8Array(await output.arrayBuffer());
      bytes += content.byteLength;
      digest.update(content);
    }
    bundles.push({ name, bytes, sha256: digest.digest("hex"), elapsedMs: performance.now() - started });
  }
  return { kind: "in-memory-validation", packages: "external", minify: false, bundles };
}

async function runSuite(suite: string, browserPath: string) {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, "test", suite], {
    cwd: root,
    env: { ...process.env, CHATGPT_DOM_TEST_BROWSER: browserPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const elapsedMs = performance.now() - started;
    const output = `${stdout}\n${stderr}`;
    const pass = Number(output.match(/(?:^|\n)\s*(\d+) pass\b/)?.[1] ?? 0);
    const skipped = Number(output.match(/(?:^|\n)\s*(\d+) skip\b/)?.[1] ?? 0);
    const contractBudgetMs = suite === suites[0] ? 5_000 : null;
    const success =
      exitCode === 0 && pass > 0 && skipped === 0 && (contractBudgetMs === null || elapsedMs < contractBudgetMs);
    const result = {
      suite,
      command: `bun test ${suite}`,
      exitCode,
      pass,
      skipped,
      elapsedMs,
      contractBudgetMs,
      success,
    };
    console.error(`${success ? "PASS" : "FAIL"} ${suite}: ${pass} pass, ${skipped} skip, ${elapsedMs.toFixed(1)}ms`);
    if (!success) {
      console.error(output.slice(-6_000));
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runContinuityGates(options: { samples?: number } = {}) {
  const samples = options.samples ?? 5;
  assert(Number.isInteger(samples) && samples >= 2 && samples <= 20, "Use 2–20 measured samples");
  const browserPath = resolveReplayBrowser();
  const revisionBefore = await sourceRevision();
  const fixtureDigest = createHash("sha256")
    .update(readFileSync(join(root, "tests/fixtures/continuity-replay.ts")))
    .digest("hex");
  const gates = [];
  // Keep every suite sequential; do not contend with A's focused validation.
  for (const suite of suites) {
    gates.push(await runSuite(suite, browserPath));
  }
  const build = await buildValidation();
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const scenarios = [];
  const directory = mkdtempSync(join(tmpdir(), "harness-continuity-metrics-"));
  let payload: ReturnType<typeof runCodingReplay>["payload"] | undefined;
  try {
    for (const scenario of browserScenarios) {
      const latencies = [];
      let reference: Awaited<ReturnType<typeof runBrowserReplay>> | undefined;
      for (let sample = 0; sample < samples; sample += 1) {
        const context = await browser.newContext();
        try {
          const page = await context.newPage();
          const started = performance.now();
          const result = await runBrowserReplay(page, scenario);
          latencies.push(performance.now() - started);
          assert.equal(result.sends, 1);
          if (reference) {
            assert.deepEqual(result, reference, "Each measured replay must execute the identical scenario");
          }
          reference = result;
        } finally {
          await context.close();
        }
      }
      assert.equal(browser.contexts().length, 0, "Measured browser contexts must return to baseline");
      scenarios.push({ name: scenario, ...summarizeLatencies(latencies), outcome: reference });
    }
    const codingLatencies = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      const result = runCodingReplay(join(directory, `checkpoint-${sample}.json`));
      codingLatencies.push(performance.now() - started);
      if (payload) {
        assert.deepEqual(result.payload, payload);
      }
      payload = result.payload;
    }
    scenarios.push({ name: "coding-checkpoint-persist-reload", ...summarizeLatencies(codingLatencies), payload });
  } finally {
    await browser.close();
    rmSync(directory, { recursive: true, force: true });
  }
  const revisionAfter = await sourceRevision();
  const fixtureAfter = createHash("sha256")
    .update(readFileSync(join(root, "tests/fixtures/continuity-replay.ts")))
    .digest("hex");
  const stableBuild = revisionBefore.sourceDigest === revisionAfter.sourceDigest && fixtureDigest === fixtureAfter;
  return {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    runtime: { bun: Bun.version, platform: process.platform, arch: process.arch, browser: browserPath },
    revision: revisionAfter,
    stableBuild,
    scenarioDigest: replayScenarioDigest,
    fixtureDigest,
    gates,
    build,
    scenarios,
    success: gates.every((gate) => gate.success) && stableBuild,
    liveCanary: {
      status: "not-run",
      compactationsRequired: 20,
      sessionsRequired: 2,
      minimumSessionMinutesExclusive: 22,
    },
    tokenMetric: "o200k_base ordinary text via production estimateTokens; transport JSON, not billed model usage",
  };
}

export function compareReports(
  current: Awaited<ReturnType<typeof runContinuityGates>>,
  prior: Awaited<ReturnType<typeof runContinuityGates>>,
) {
  assert.equal(prior.schemaVersion, current.schemaVersion, "Report schema mismatch");
  assert(current.stableBuild && current.success, "Comparison requires a passing, stable current measurement");
  assert(prior.stableBuild && prior.success, "Comparison requires a passing, stable measured baseline");
  assert.equal(prior.fixtureDigest, current.fixtureDigest, "Replay fixture changed; measurements are not comparable");
  assert.equal(prior.scenarioDigest, current.scenarioDigest, "Scenario mismatch");
  assert.deepEqual(prior.runtime, current.runtime, "Runtime/browser mismatch");
  assert.equal(prior.scenarios.length, current.scenarios.length);
  return current.scenarios.map((scenario, index) => {
    const old = prior.scenarios[index]!;
    assert.equal(old.name, scenario.name);
    assert.equal(old.sampleCount, scenario.sampleCount, "Sample count mismatch");
    return { name: scenario.name, p50DeltaMs: scenario.p50Ms - old.p50Ms, p95DeltaMs: scenario.p95Ms - old.p95Ms };
  });
}

if (import.meta.main) {
  try {
    const reportArg = process.argv.find((argument) => argument.startsWith("--report="));
    const compareArg = process.argv.find((argument) => argument.startsWith("--compare="));
    const samplesArg = process.argv.find((argument) => argument.startsWith("--samples="));
    const report = await runContinuityGates({ samples: samplesArg ? Number(samplesArg.slice(10)) : undefined });
    const comparison = compareArg
      ? compareReports(report, JSON.parse(readFileSync(compareArg.slice(10), "utf8")))
      : null;
    const output = `${JSON.stringify({ ...report, comparison }, null, 2)}\n`;
    if (reportArg) {
      const path = resolve(reportArg.slice(9));
      const location = relative(root, path);
      assert(
        location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location),
        "Write measurement reports outside the shared workspace",
      );
      writeFileSync(path, output);
    }
    process.stdout.write(output);
    process.exitCode = report.success ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
