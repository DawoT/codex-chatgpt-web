import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBundleIntegrity } from "../scripts/verify-bundle-integrity";

describe("Sprint Y: Automated Bundle Integrity Pre-Flight Gate", () => {
  let mockDist: string;

  beforeEach(() => {
    mockDist = mkdtempSync(join(tmpdir(), "cgw-bundle-preflight-"));
  });

  afterEach(() => {
    rmSync(mockDist, { recursive: true, force: true });
  });

  test("passes when bundles are valid CommonJS and adequately sized", () => {
    // Valid CJS helper (> 100 bytes)
    const validCjs = `
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
function helper() {
  return "launcher-ready";
}
module.exports = { helper };
`;
    writeFileSync(join(mockDist, "browser-helper.cjs"), validCjs);

    // Valid CLI (> 1000 bytes)
    const validCli = `#!/usr/bin/env bun\n` + `// runtime bundle\n`.repeat(100);
    writeFileSync(join(mockDist, "cli.js"), validCli);

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("fails closed when browser-helper.cjs is missing", () => {
    writeFileSync(join(mockDist, "cli.js"), `// cli\n`.repeat(100));

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("Missing required bundle") && e.includes("browser-helper.cjs"))).toBe(true);
  });

  test("fails closed when cli.js is missing", () => {
    writeFileSync(join(mockDist, "browser-helper.cjs"), `"use strict";\n`.repeat(20));

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("Missing required bundle") && e.includes("cli.js"))).toBe(true);
  });

  test("fails closed when browser-helper.cjs contains top-level ESM import (incident regression test)", () => {
    const invalidHelper = `
import { createRequire } from "node:module";
var require = createRequire(import.meta.url);
function run() {}
module.exports = { run };
`;
    writeFileSync(join(mockDist, "browser-helper.cjs"), invalidHelper);
    writeFileSync(join(mockDist, "cli.js"), `// cli\n`.repeat(100));

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("top-level ESM 'import' statements"))).toBe(true);
  });

  test("fails closed when browser-helper.cjs contains top-level ESM export", () => {
    const invalidHelper = `
"use strict";
export const helper = () => {};
`;
    writeFileSync(join(mockDist, "browser-helper.cjs"), invalidHelper);
    writeFileSync(join(mockDist, "cli.js"), `// cli\n`.repeat(100));

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("top-level ESM 'export' statements"))).toBe(true);
  });

  test("fails closed when browser-helper.cjs has syntax errors detected by node -c", () => {
    const syntaxErrorHelper = `
"use strict";
var x = ; // syntax error
function bad() {}
module.exports = { bad };
`.repeat(5);
    writeFileSync(join(mockDist, "browser-helper.cjs"), syntaxErrorHelper);
    writeFileSync(join(mockDist, "cli.js"), `// cli\n`.repeat(100));

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("Node syntax check failed"))).toBe(true);
  });

  test("fails closed when bundles are suspiciously small (truncated/empty builds)", () => {
    writeFileSync(join(mockDist, "browser-helper.cjs"), "empty");
    writeFileSync(join(mockDist, "cli.js"), "empty");

    const result = verifyBundleIntegrity({ distDir: mockDist });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("browser-helper.cjs is suspiciously small"))).toBe(true);
    expect(result.errors.some(e => e.includes("cli.js is suspiciously small"))).toBe(true);
  });
});
