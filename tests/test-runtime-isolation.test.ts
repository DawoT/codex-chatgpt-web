import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, getConfigDir } from "../src/config";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const importedHome = getConfigDir();

afterEach(() => {
  // Several existing suites clear this variable after their own temporary fixtures.
  delete process.env.CODEX_CHATGPT_WEB_HOME;
});

test("Bun tests isolate default runtime paths before module initialization", () => {
  expect(process.env.CODEX_CHATGPT_WEB_TEST_HOME).toBeDefined();
  expect(importedHome).toBe(process.env.CODEX_CHATGPT_WEB_TEST_HOME!);
  expect(getConfigDir()).toBe(process.env.CODEX_CHATGPT_WEB_TEST_HOME!);
  expect(defaultBrokerEndpoint()).not.toBe(defaultBrokerEndpoint(join(homedir(), ".codex-chatgpt-web")));
  if (process.env.CGW_ISOLATION_CHILD === "1") {
    console.log(`isolated-home:${getConfigDir()}`);
  }
});

test("direct bun test overrides an inherited live home and removes its temporary home on exit", async () => {
  const child = Bun.spawn([process.execPath, "test", import.meta.path, "--test-name-pattern", "Bun tests isolate default runtime"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CODEX_CHATGPT_WEB_HOME: join(homedir(), ".codex-chatgpt-web"), CGW_ISOLATION_CHILD: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(status, stderr).toBe(0);
  const childHome = stdout.match(/isolated-home:([^\r\n]+)/)?.[1];
  expect(childHome).toBeDefined();
  expect(childHome).not.toBe(process.env.CODEX_CHATGPT_WEB_TEST_HOME);
  expect(existsSync(childHome!)).toBeFalse();
});

test("a previous test clearing its home cannot bind the user's broker", async () => {
  expect(getConfigDir()).toBe(process.env.CODEX_CHATGPT_WEB_TEST_HOME!);
  expect(getConfigDir()).not.toBe(join(homedir(), ".codex-chatgpt-web"));
  const socket = defaultBrokerEndpoint();
  const broker = TurnBroker.forSocket(socket);
  try {
    await broker.listen();
    expect(socket).toBe(defaultBrokerEndpoint(process.env.CODEX_CHATGPT_WEB_TEST_HOME!));
  } finally {
    await broker.close();
  }
});
