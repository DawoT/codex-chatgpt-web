import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SessionActorJournal } from "../src/adapters/chatgpt-web/session-actor";
import { defaultConfig, getConfigDir } from "../src/config";
import { startServer } from "../src/server";

for (const mode of ["full", "browser-only"] as const) {
  test(`${mode} launcher daemon owns and releases its session journal`, async () => {
    const config = defaultConfig(mode);
    config.port = 0;
    config.browserHost = "launcher";
    config.browserInteractionMode = "automatic";
    config.browserHostDescriptorPath = join(getConfigDir(), "test-launcher.json");
    config.brokerSocketPath = join(getConfigDir(), "runtime", "actor-test.sock");
    const journalPath = join(getConfigDir(), "runtime", "session-actors", "events.sqlite");
    const server = startServer(config);
    try {
      expect(existsSync(journalPath)).toBe(true);
      expect(() => new SessionActorJournal(journalPath)).toThrow("already owned");
    } finally {
      await server.stop(true);
    }
    const reopened = new SessionActorJournal(journalPath);
    reopened.close();
  });
}

test("a failed listener bind releases the session journal writer", () => {
  const occupied = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const config = defaultConfig("browser-only");
  config.port = occupied.port;
  config.browserHost = "launcher";
  config.browserInteractionMode = "automatic";
  config.browserHostDescriptorPath = join(getConfigDir(), "test-launcher.json");
  const journalPath = join(getConfigDir(), "runtime", "session-actors", "events.sqlite");
  try {
    expect(() => startServer(config)).toThrow();
    const recovered = new SessionActorJournal(journalPath);
    recovered.close();
  } finally {
    occupied.stop();
  }
});
