import { defaultConfig } from "../../src/config";
import { HostHttpRoutes } from "../../src/server/host-routes";
import { HttpTurnCounter } from "../../src/server/http-turn-counter";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Missing owned recovery workspace");
const mode = process.argv[3] === "complete" ? "complete" : "held";

const routes = new HostHttpRoutes({
  ...defaultConfig("full"),
  controlToken: "recovery-pairing",
  rateLimitRpm: 0,
}, new HttpTurnCounter(), () => ({
  name: "held-recovery-fixture",
  async runTurn(_parsed, options, emit) {
    emit({ type: "text_delta", text: "started" });
    if (mode === "complete") {
      emit({ type: "done" });
      return;
    }
    await new Promise<void>(resolve => {
      options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
  },
}), undefined, join(root, "journal"));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async request => (await routes.handle(request)) ?? new Response(null, { status: 404 }),
});

process.stdout.write(JSON.stringify({ port: server.port }) + "\n");
