/**
 * Refactor acceptance gates: production double casts, unused-private suppressions,
 * any direct worker prototype reference in tests (including subprocess scripts),
 * and source-text assertions. Unrelated Object.create fixtures are permitted.
 * Default mode reports progress; --strict fails on any remaining occurrence.
 * --root DIR runs the same scanner against a controlled tree for regression checks.
 * Prototype scanning includes strings intentionally: embedded helper scripts execute as code.
 * Source-read scanning resolves common static paths and allows temporary tool outputs.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";

const rootIndex = process.argv.indexOf("--root");
if (rootIndex >= 0 && !process.argv[rootIndex + 1]) {
  throw new Error("--root requires a directory");
}
const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]!) : resolve(import.meta.dir, "..");

/** Scan the worker and every current/future browser module, including planning helpers. */
const ADAPTER_FILES = [
  "src/adapters/chatgpt-web/browser-worker.ts",
  ...collectTypeScriptFiles("src/adapters/chatgpt-web/browser"),
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

/** Resolve common static path forms; temporary output roots stay outside the repository. */
function countReadFileSyncCallsOnSrc(text: string, file: string): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const resolveExpression = (node: ts.Expression, resolving = new Set<ts.Node>()): string | undefined => {
    if (resolving.has(node)) return undefined;
    const seen = new Set(resolving).add(node);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return resolveExpression(node.expression, seen);
    if (node.getText(source) === "import.meta.dir") return dirname(join(root, file));
    if (ts.isIdentifier(node)) {
      for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
        if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement) || statement.getStart(source) > node.getStart(source)) continue;
          const declaration = statement.declarationList.declarations.find(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === node.text,
          );
          if (declaration?.initializer) return resolveExpression(declaration.initializer, seen);
        }
      }
      return undefined;
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === "URL") {
      const argument = node.arguments?.[0];
      const base = node.arguments?.[1];
      if (argument && base?.getText(source) === "import.meta.url") {
        const relative = resolveExpression(argument, seen);
        return relative === undefined ? undefined : resolve(dirname(join(root, file)), relative);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (callee === "mkdtempSync") return join(root, "__temporary_fixture_output__");
      if (callee === "process.cwd") return root;
      if (callee === "join" || callee === "resolve") {
        const parts = node.arguments.map((argument) => resolveExpression(argument, seen));
        if (parts.some((part) => part === undefined)) return undefined;
        return resolve(root, ...(parts as string[]));
      }
    }
    return undefined;
  };
  let count = 0;
  const sourceRoot = join(root, "src");
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source).split(".").at(-1) === "readFileSync") {
      const argument = node.arguments[0];
      const path = argument && resolveExpression(argument);
      if (path !== undefined) {
        const absolute = resolve(root, path);
        if (absolute === sourceRoot || absolute.startsWith(`${sourceRoot}${sep}`)) count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
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
  count: (readFileSync(join(root, file), "utf8").match(/as\s+unknown\s+as/g) ?? []).length,
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

console.log("Gate 3 — direct worker prototype references in tests/ (target 0 per file)");
const prototypeFakes = collectTypeScriptFiles(TESTS_DIR).map((file) => ({
  file,
  count: (
    readFileSync(join(root, file), "utf8").match(
      /\bChatGptBrowserWorker\s*(?:\.\s*prototype|\[\s*["']prototype["']\s*\])/g,
    ) ?? []
  ).length,
}));
printPerFile(prototypeFakes, 0);
console.log(`    summary: current ${sum(prototypeFakes)}, target 0 across ${prototypeFakes.length} scanned test files`);
if (sum(prototypeFakes) > 0) failing = true;
console.log("");

console.log(
  "Gate 4 — source-text assertions in tests/ (`readFileSync` applied to src/ paths; sprint-4 target 0 per file)",
);
const srcReads = collectTypeScriptFiles(TESTS_DIR).map((file) => ({
  file,
  count: countReadFileSyncCallsOnSrc(readFileSync(join(root, file), "utf8"), file),
}));
printPerFile(srcReads, 0);
console.log(`    summary: current ${sum(srcReads)}, target 0 across ${srcReads.length} scanned test files`);
if (sum(srcReads) > 0) failing = true;
console.log("");

console.log(
  strict
    ? `Result: ${failing ? "FAIL — gate targets not met" : "PASS — all gate targets met"}`
    : "Result: report only (counts are expected to be nonzero mid-refactor; --strict enforces targets)",
);

if (strict && failing) {
  process.exit(1);
}
