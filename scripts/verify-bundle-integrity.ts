import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface BundleIntegrityCheckResult {
  ok: boolean;
  errors: string[];
}

export interface VerifyBundleOptions {
  distDir?: string;
  nodeBin?: string;
}

export function verifyBundleIntegrity(options: VerifyBundleOptions = {}): BundleIntegrityCheckResult {
  const root = resolve(import.meta.dir, "..");
  const distDir = options.distDir ?? resolve(root, "dist");
  const nodeBin = options.nodeBin ?? process.execPath.includes("node") ? process.execPath : "node";
  const errors: string[] = [];

  // 1. Verify browser-helper.cjs
  const helperPath = resolve(distDir, "browser-helper.cjs");
  if (!existsSync(helperPath)) {
    errors.push(`Missing required bundle: ${helperPath}`);
  } else {
    const stats = statSync(helperPath);
    if (stats.size < 100) {
      errors.push(`browser-helper.cjs is suspiciously small (${stats.size} bytes)`);
    }

    const content = readFileSync(helperPath, "utf8");

    // Check for top-level ESM import statements
    if (/^import\s+/m.test(content)) {
      errors.push("browser-helper.cjs contains top-level ESM 'import' statements (must be pure CommonJS)");
    }

    // Check for top-level ESM export statements
    if (/^export\s+(default|const|let|var|function|class|\*|\{)/m.test(content)) {
      errors.push("browser-helper.cjs contains top-level ESM 'export' statements (must be pure CommonJS)");
    }

    // Node syntax check (node -c)
    try {
      const check = spawnSync(nodeBin, ["-c", helperPath], { encoding: "utf8" });
      if (check.status !== 0) {
        errors.push(
          `Node syntax check failed on browser-helper.cjs (exit ${check.status}): ${(check.stderr || "").trim()}`,
        );
      }
    } catch (err) {
      errors.push(`Failed to invoke '${nodeBin} -c': ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Verify cli.js
  const cliPath = resolve(distDir, "cli.js");
  if (!existsSync(cliPath)) {
    errors.push(`Missing required bundle: ${cliPath}`);
  } else {
    const stats = statSync(cliPath);
    if (stats.size < 1000) {
      errors.push(`cli.js is suspiciously small (${stats.size} bytes)`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

if (import.meta.main) {
  const result = verifyBundleIntegrity();
  if (result.ok) {
    console.log("✓ Bundle integrity pre-flight check passed: dist/ bundles are valid and CJS-compliant.");
    process.exit(0);
  } else {
    console.error("✗ Bundle integrity pre-flight check FAILED:");
    for (const error of result.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}
