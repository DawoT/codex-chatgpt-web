import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const descriptor = await Bun.file(process.argv[2] ?? "/tmp/cgw-temporary-continuity/build.txt").json();
const candidate = descriptor.candidate ?? descriptor;
const manifest = await Bun.file(join(candidate.runtimeRoot, "manifest.json")).json();
const root = mkdtempSync("/tmp/cgw-candidate-smoke-");
const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = listener.port;
listener.stop();
const config = {
  version: 3,
  releaseVersion: "6.2.0",
  mode: "browser-only",
  contextWindow: 256_000,
  appName: "Codex Native",
  headed: false,
  chromeExecutablePath: "/usr/bin/chromium",
  solAvailable: true,
  extraHighAvailable: false,
  proAvailable: false,
  autoApproveToolCalls: false,
  useSavedChats: false,
  runtimeCommand: [process.execPath, candidate.entrypoint],
  host: "127.0.0.1",
  port,
  browserHost: "managed-chrome",
  storageStatePath: join(root, "browser", "storage-state.json"),
  brokerSocketPath: join(root, "broker.sock"),
  controlToken: "c".repeat(64),
  acknowledgedUnofficialAt: new Date().toISOString(),
};
mkdirSync(join(root, "browser"), { recursive: true });
writeFileSync(join(root, "config.json"), JSON.stringify(config), { mode: 0o600 });
writeFileSync(config.storageStatePath, "{}", { mode: 0o600 });
const child = Bun.spawn([process.execPath, candidate.entrypoint, "serve"], {
  env: { ...process.env, CODEX_CHATGPT_WEB_HOME: root },
  stdout: "ignore",
  stderr: "pipe",
});
try {
  let health: Record<string, unknown> | undefined;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {}
    await Bun.sleep(50);
  }
  const identity = health?.runtime_identity as Record<string, unknown> | undefined;
  if (identity?.artifactSetSha256 !== candidate.artifactSetSha256 ||
    identity.artifactVerification !== "paired_manifest_verified" || identity.pid !== child.pid ||
    identity.artifactSha256 !== manifest.files.find((file: {path: string}) => file.path === "app/cli.js").sha256) {
    console.log(JSON.stringify({ health, expected: candidate.artifactSetSha256, pid: child.pid }));
    throw new Error("Candidate daemon identity did not match its manifest");
  }
  const rejected = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: "test", stream: false }),
  });
  if (rejected.status !== 400) throw new Error(`Invalid model status ${rejected.status}`);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST", headers: { authorization: "Bearer invalid-smoke-control" },
  });
  if (unauthorized.status !== 401) throw new Error("Unauthorized drain accepted");
  const drain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST", headers: { authorization: `Bearer ${config.controlToken}` },
  });
  const acknowledgement = await drain.json();
  if (!drain.ok || acknowledgement.accepting_turns !== false ||
    acknowledgement.active_http_turns !== 0 || acknowledgement.active_browser_turns !== 0) {
    throw new Error("Candidate did not drain an idle profile");
  }
  const helper = Bun.spawn(["node", candidate.helperPath], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  helper.stdin.write('{"type":"shutdown"}\n');
  helper.stdin.end();
  const [helperOutput, helperErrors, helperExit] = await Promise.all([
    new Response(helper.stdout).text(), new Response(helper.stderr).text(), helper.exited,
  ]);
  const ready = JSON.parse(helperOutput.trim().split("\n")[0]);
  if (helperExit !== 0 || ready.type !== "ready" ||
    ready.identity?.artifactSetSha256 !== candidate.artifactSetSha256 ||
    ready.identity.artifactVerification !== "paired_manifest_verified" ||
    ready.identity.artifactSha256 !== manifest.files.find((file: {path: string}) => file.path === "app/browser-helper.cjs").sha256) {
    throw new Error(`Compiled helper identity mismatch: ${helperErrors}`);
  }
  console.log(JSON.stringify({ status: "passed", identity, helperIdentity: ready.identity, invalidModel: 400, invalidDrain: 401,
    drained: true, profile: "isolated temporary directory", activeDaemonRestarted: false }));
} finally {
  child.kill("SIGTERM");
  await child.exited;
  console.log(await new Response(child.stderr).text());
  rmSync(root, { recursive: true, force: true });
}
