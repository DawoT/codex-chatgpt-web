#!/usr/bin/env bun
import { pruneCodexSessions, defaultCodexSessionsDir } from "../src/adapters/chatgpt-web/session-store-pruner";

function parseArgs(args: string[]) {
  let dryRun = false;
  let maxFiles: number | undefined;
  let maxTotalBytes: number | undefined;
  let maxAgeMs: number | undefined;
  let protectRecentMs = 3_600_000; // 1 hour
  let targetSources: string[] | undefined;
  let minFileSizeBytes: number | undefined;
  let jsonOutput = false;
  let sessionsDir = defaultCodexSessionsDir();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--subagents-only") {
      targetSources = ["subagent:thread_spawn", "subagent:other"];
    } else if (arg === "--mega-files-only") {
      minFileSizeBytes = 50 * 1024 * 1024; // 50 MB
    } else if (arg === "--dir" && i + 1 < args.length) {
      sessionsDir = args[++i];
    } else if (arg === "--max-files" && i + 1 < args.length) {
      maxFiles = parseInt(args[++i], 10);
    } else if (arg === "--max-bytes" && i + 1 < args.length) {
      const raw = args[++i];
      if (raw.endsWith("MB") || raw.endsWith("mb")) {
        maxTotalBytes = parseFloat(raw) * 1024 * 1024;
      } else if (raw.endsWith("GB") || raw.endsWith("gb")) {
        maxTotalBytes = parseFloat(raw) * 1024 * 1024 * 1024;
      } else {
        maxTotalBytes = parseInt(raw, 10);
      }
    } else if (arg === "--max-age-days" && i + 1 < args.length) {
      maxAgeMs = parseFloat(args[++i]) * 86_400_000;
    } else if (arg === "--protect-recent-hours" && i + 1 < args.length) {
      protectRecentMs = parseFloat(args[++i]) * 3_600_000;
    }
  }

  return {
    sessionsDir,
    dryRun,
    maxFiles,
    maxTotalBytes,
    maxAgeMs,
    protectRecentMs,
    targetSources,
    minFileSizeBytes,
    jsonOutput,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = pruneCodexSessions(options);

  if (options.jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("=================================================");
  console.log("  Codex Rollout Session Store Pruner");
  console.log("=================================================");
  console.log(`Directory:       ${options.sessionsDir}`);
  console.log(`Dry Run:         ${result.dryRun ? "YES (simulation only)" : "NO (files deleted)"}`);
  console.log(`Scanned Files:   ${result.scannedFiles}`);
  console.log(`Initial Size:    ${formatBytes(result.totalInitialBytes)}`);
  console.log(`Pruned Files:    ${result.prunedFiles.length}`);
  console.log(`Reclaimed Space: ${formatBytes(result.reclaimedBytes)}`);
  console.log(`Remaining Files: ${result.remainingFiles}`);
  console.log(`Remaining Size:  ${formatBytes(result.remainingBytes)}`);
  console.log("-------------------------------------------------");

  if (result.prunedFiles.length > 0) {
    console.log("Pruned Rollouts (sample top 10):");
    const sample = result.prunedFiles.slice(0, 10);
    for (const f of sample) {
      console.log(`  - [${formatBytes(f.size)}] ${f.filename} (${f.reason})`);
    }
    if (result.prunedFiles.length > 10) {
      console.log(`  ... and ${result.prunedFiles.length - 10} more files.`);
    }
  } else {
    console.log("No rollouts met the pruning criteria. Session store is healthy!");
  }
  console.log("=================================================");
}

void main().catch(err => {
  console.error("Pruner failed:", err);
  process.exit(1);
});
