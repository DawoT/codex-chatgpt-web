/**
 * Refactor gate checks for the ChatGPT web adapter decomposition sprint
 * (see CONTEXT.md for the seam vocabulary this sprint is carving out).
 *
 * Four gates, each with a per-file current count and a target:
 *   1. `as unknown as` casts in the adapter worker and its composed controllers (target 0 per file).
 *   2. `biome-ignore` comments for `noUnusedPrivateClassMembers` in the same files
 *      (target 0: suppressions for private members that exist only to satisfy tests).
 *   3. Test-only seams that sprint 4 eliminates: worker-prototype fakes
 *      (`Object.create(ChatGptBrowserWorker.prototype)`) in `tests/`.
 *   4. Source-text assertions in `tests/`: `readFileSync` applied to paths under `src/`.
 *
 * The scanning is deliberately heuristic plain `node:fs` string matching, not an AST walk: it
 * needs no new dependency, and the patterns above are stable string idioms. Consequences:
 * - `as unknown as` counts include benign casts in the target files; the gate only tracks the
 *   trajectory toward 0, review decides which individual casts are load-boundary casts.
 * - A `readFileSync` call is attributed to `src/` when the text following the call references
 *   `../src/` (import.meta.url-relative) or a `"src/`-prefixed path (cwd-relative). Path strings
 *   that merely contain a `"src"` component (e.g. `join(root, "src", ...)`) do not match.
 *   Multi-line calls are covered because the scan is textual, not line-anchored.
 *
 * Without `--strict` the script is report-only and always exits 0 (current counts are expected
 * to be nonzero mid-refactor). With `--strict` it exits 1 when any counted occurrence is
 * nonzero. Run from anywhere: `bun run check:refactor-gates [-- --strict]`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Gate 1 + 2 targets: the worker entry point and the composed controllers under browser/. */
const ADAPTER_FILES = [
  "src/adapters/chatgpt-web/browser-worker.ts",
  "src/adapters/chatgpt-web/browser/browser-session.ts",
  "src/adapters/chatgpt-web/browser/composer-controller.ts",
  "src/adapters/chatgpt-web/browser/submission-observer.ts",
  "src/adapters/chatgpt-web/browser/turn-diagnostics.ts",
  "src/adapters/chatgpt-web/browser/response-observer.ts",
  "src/adapters/chatgpt-web/browser/model-controls.ts",
];

const TESTS_DIR = "tests";

/** Recursively collects `.ts` file paths under `dir` (repo-root-relative), sorted for stable output. */
function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, dir))) {
    const relativePath = join(dir, entry);
    if (statSync(join(root, relativePath)).isDirectory()) {
      files.push(...collectTypeScriptFiles(relativePath));
    } else if (entry.endsWith(".ts")) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Heuristic: a `readFileSync` call counts as a source-text assertion when its argument (the
 * text between the call's parentheses) references the repository's `src/` tree (see module doc).
 * The argument is approximated by scanning to the call's matching close paren, capped for safety. */
function countReadFileSyncCallsOnSrc(text: string): number {
  let count = 0;
  for (const match of text.matchAll(/readFileSync\s*\(/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = Math.min(text.length, start + 4000);
    let depth = 1;
    let cursor = start;
    while (cursor < end && depth > 0) {
      const char = text[cursor];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      cursor += 1;
    }
    const argument = text.slice(start, depth === 0 ? cursor - 1 : cursor);
    if (/\.\.\/src\//.test(argument) || /["'`]src\//.test(argument)) {
      count += 1;
    }
  }
  return count;
}

interface FileCount {
  file: string;
  count: number;
}

function sum(counts: FileCount[]): number {
  return counts.reduce((accumulator, entry) => accumulator + entry.count, 0);
}

/** Per-file counts sorted descending by count, then path; zero-count files are dropped. */
function nonZero(counts: FileCount[]): FileCount[] {
  return counts.filter((entry) => entry.count > 0).sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function printPerFile(counts: FileCount[], target: number): void {
  const relevant = nonZero(counts);
  if (relevant.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const entry of relevant) {
    console.log(`    ${entry.file}: ${entry.count} / ${target}`);
  }
}

const strict = process.argv.includes("--strict");
console.log(`Refactor gate report${strict ? " (--strict)" : " (report mode — pass --strict to enforce targets)"}\n`);

let failing = false;

console.log("Gate 1 — `as unknown as` casts in adapter sources (target 0 per file)");
const adapterCasts = ADAPTER_FILES.map((file) => ({
  file,
  count: countOccurrences(readFileSync(join(root, file), "utf8"), "as unknown as"),
}));
printPerFile(adapterCasts, 0);
console.log(`    summary: current ${sum(adapterCasts)}, target 0 across ${ADAPTER_FILES.length} files`);
if (sum(adapterCasts) > 0) failing = true;
console.log("");

console.log("Gate 2 — `biome-ignore` noUnusedPrivateClassMembers in adapter sources (target 0 per file)");
const adapterSuppressions = ADAPTER_FILES.map((file) => ({
  file,
  count: (readFileSync(join(root, file), "utf8").match(/biome-ignore[^\n]*noUnusedPrivateClassMembers/g) ?? []).length,
}));
printPerFile(adapterSuppressions, 0);
console.log(`    summary: current ${sum(adapterSuppressions)}, target 0 across ${ADAPTER_FILES.length} files`);
if (sum(adapterSuppressions) > 0) failing = true;
console.log("");

console.log(
  "Gate 3 — worker-prototype fakes in tests/ (`Object.create(ChatGptBrowserWorker.prototype)`; sprint-4 target 0 per file)",
);
const prototypeFakes = collectTypeScriptFiles(TESTS_DIR).map((file) => ({
  file,
  count: countOccurrences(readFileSync(join(root, file), "utf8"), "Object.create(ChatGptBrowserWorker.prototype)"),
}));
printPerFile(prototypeFakes, 0);
console.log(`    summary: current ${sum(prototypeFakes)}, target 0 across ${prototypeFakes.length} scanned test files`);
if (sum(prototypeFakes) > 0) failing = strict ? true : failing;
console.log("");

console.log(
  "Gate 4 — source-text assertions in tests/ (`readFileSync` applied to src/ paths; sprint-4 target 0 per file)",
);
const srcReads = collectTypeScriptFiles(TESTS_DIR).map((file) => ({
  file,
  count: countReadFileSyncCallsOnSrc(readFileSync(join(root, file), "utf8")),
}));
printPerFile(srcReads, 0);
console.log(`    summary: current ${sum(srcReads)}, target 0 across ${srcReads.length} scanned test files`);
if (sum(srcReads) > 0) failing = strict ? true : failing;
console.log("");

console.log(
  strict
    ? `Result: ${failing ? "FAIL — gate targets not met" : "PASS — all gate targets met"}`
    : "Result: report only (counts are expected to be nonzero mid-refactor; --strict enforces targets)",
);

if (strict && failing) {
  process.exit(1);
}
