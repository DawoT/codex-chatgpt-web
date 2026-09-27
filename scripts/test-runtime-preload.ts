import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Configure before test modules import the bridge. Never inherit the live launcher's home.
const testHome = mkdtempSync(join(tmpdir(), "cgw-tests-"));
const restoreTestHome = () => {
  mkdirSync(testHome, { recursive: true });
  process.env.CODEX_CHATGPT_WEB_HOME = testHome;
  process.env.CODEX_CHATGPT_WEB_TEST_HOME = testHome;
};

restoreTestHome();
beforeEach(restoreTestHome);
afterEach(restoreTestHome);

// Bun's test runner does not consistently dispatch process exit handlers. Use its lifecycle.
afterAll(async () => {
  const { closeTurnBrokers } = await import("../src/adapters/chatgpt-web/turn-broker");
  try {
    await closeTurnBrokers();
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
});

// Default brokers belong to this test process; removal never touches the user's runtime.
process.once("exit", () => {
  rmSync(testHome, { recursive: true, force: true });
});
