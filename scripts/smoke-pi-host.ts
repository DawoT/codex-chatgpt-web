import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultConfig } from "../src/config";
import { HostHttpRoutes } from "../src/server/host-routes";
import { HttpTurnCounter } from "../src/server/http-turn-counter";

// Scripted model output exercises the actual HTTP boundary and installed Pi runtime.
// It does not exercise a ChatGPT browser or make a model call.
const gentleRoot = resolve(process.argv[2] ?? "../gentle-shell");
const probe = join(gentleRoot, "tests/support/codex-web-host-probe.mjs");
if (!existsSync(probe)) throw new Error("Supply the Gentle Shell checkout containing the host probe");
const root = mkdtempSync(join(tmpdir(), "pi-host-smoke-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
mkdirSync(workspace);
mkdirSync(agentDir);
writeFileSync(join(workspace, "source.ts"), "export function double(value: number): number { return value * 2; }\n");
for (const args of [["init", "-b", "main"], ["add", "source.ts"], ["-c", "user.name=Host Probe", "-c", "user.email=probe@example.invalid", "commit", "-m", "fixture"]]) {
  const result = spawnSync("git", args, { cwd: workspace });
  if (result.status !== 0) throw new Error("Cannot create host probe repository");
}
let rounds = 0;
const sessionRounds = new Map<string, number>();
const cancelledSessions = new Set<string>();
const routes = new HostHttpRoutes({ ...defaultConfig("full"), controlToken: "host-probe-pairing" }, new HttpTurnCounter(), () => ({
  name: "scripted-host-probe",
  async runTurn(parsed, _options, emit) {
    rounds += 1;
    const sessionId = parsed._hostTurn!.sessionId;
    const round = (sessionRounds.get(sessionId) ?? 0) + 1;
    sessionRounds.set(sessionId, round);
    if (round <= 2) {
      emit({ type: "tool_call_start", id: `call_${sessionId}_${round}`, name: round === 1 ? "facts_query" : "bash" });
      emit({ type: "tool_call_delta", arguments: round === 1 ? '{"name":"double"}' : '{"command":"printf denied > denied"}' });
      emit({ type: "tool_call_end" });
    } else if (round === 4 || round === 6) {
      emit({ type: "tool_call_start", id: `call_${sessionId}_${round}`, name: "bash" });
      emit({ type: "tool_call_delta", arguments: JSON.stringify({
        command: round === 4 ? "printf allowed > allowed" : "printf ready > ready; sleep 30; printf late > late",
      }) });
      emit({ type: "tool_call_end" });
    } else {
      const results = parsed.context.messages.filter(message => message.role === "toolResult");
      if (round === 3 && results.length < 2) throw new Error("Pi failed to return both tool results through host HTTP");
      emit({ type: "text_delta", text: "Host protocol verified" });
    }
    emit({ type: "done" });
  },
}));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  if (new URL(request.url).pathname.endsWith("/cancel")) cancelledSessions.add(new URL(request.url).pathname.split("/")[4]!);
  if (new URL(request.url).pathname === "/healthz") return Response.json({ hostProtocol: 1 });
  return await routes.handle(request) ?? new Response(null, { status: 404 });
} });
try {
  const launch = (workspacePath: string, agentPath: string) => Bun.spawn(["node", "--experimental-strip-types", probe], {
    cwd: gentleRoot,
    env: {
      ...process.env,
      PI_HOST_PROBE_WORKSPACE: workspacePath,
      PI_HOST_PROBE_AGENT_DIR: agentPath,
      CODEX_CHATGPT_WEB_HOME: join(root, "empty-config"),
      GENTLE_CODEX_WEB_URL: `http://127.0.0.1:${server.port}`,
      GENTLE_CODEX_WEB_TOKEN: "host-probe-pairing",
      GENTLE_CODEX_WEB: "1",
    },
    stdout: "inherit", stderr: "inherit",
  });
  const secondWorkspace = join(root, "second-workspace");
  const secondAgent = join(root, "second-agent");
  const clone = spawnSync("git", ["clone", workspace, secondWorkspace]);
  if (clone.status !== 0) throw new Error("Cannot create second isolated workspace");
  mkdirSync(secondAgent);
  const children = [launch(workspace, agentDir), launch(secondWorkspace, secondAgent)];
  const deadline = setTimeout(() => children.forEach(child => child.kill()), 30000);
  const exitCodes = await Promise.all(children.map(child => child.exited));
  clearTimeout(deadline);
  if (exitCodes.some(code => code !== 0) || rounds !== 20 || sessionRounds.size !== 4
    || [...sessionRounds.values()].filter(count => count === 7).length !== 2
    || [...sessionRounds.values()].filter(count => count === 3).length !== 2 || cancelledSessions.size !== 2
    || routes.store.sessions.size !== 0) {
    throw new Error("Concurrent Pi host integration failed or leaked session state");
  }
  console.log("Host HTTP probe: two concurrent Pi sessions, reconnection, twenty rounds, scoped cancellation and zero retained sessions passed");
} finally {
  await routes.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
