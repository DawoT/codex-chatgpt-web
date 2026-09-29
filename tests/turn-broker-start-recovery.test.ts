import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

async function externalOwner(path: string): Promise<Server> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return server;
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
async function connect(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
  });
}

test.skipIf(process.platform === "win32")(
  "same broker can start on a new request after external owner retires",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-start-recovery-"));
    const path = join(root, "broker.sock");
    const external = await externalOwner(path);
    const broker = TurnBroker.forSocket(path);
    try {
      const outcomes = await Promise.allSettled([broker.listen(), broker.listen()]);
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBeTrue();
      expect(existsSync(path)).toBeTrue();
      await connect(path);
      await closeServer(external);
      await broker.listen();
      await connect(path);
    } finally {
      if (external.listening) await closeServer(external);
      await broker.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("closing rejected broker preserves live external socket", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-close-rejected-"));
  const path = join(root, "broker.sock");
  const external = await externalOwner(path);
  const broker = TurnBroker.forSocket(path);
  try {
    await expect(broker.listen()).rejects.toThrow("already owned");
    await broker.close();
    expect(existsSync(path)).toBeTrue();
    await connect(path);
  } finally {
    await closeServer(external);
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "repeated unsafe endpoint starts fail closed without deleting endpoint",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-start-unsafe-"));
    const path = join(root, "broker.sock");
    const broker = TurnBroker.forSocket(path);
    try {
      writeFileSync(path, "must remain");
      await expect(broker.listen()).rejects.toThrow("not a socket");
      await expect(broker.listen()).rejects.toThrow("not a socket");
      await broker.close();
      expect(existsSync(path)).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "retry does not bypass unsafe permissions on live external endpoint",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cgw-start-mode-"));
    const path = join(root, "broker.sock");
    const external = await externalOwner(path);
    const broker = TurnBroker.forSocket(path);
    try {
      chmodSync(path, 0o666);
      await expect(broker.listen()).rejects.toThrow("unsafe permissions");
      await expect(broker.listen()).rejects.toThrow("unsafe permissions");
      chmodSync(path, 0o600);
      await expect(broker.listen()).rejects.toThrow("already owned");
      await broker.close();
      await connect(path);
    } finally {
      await closeServer(external);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("invalid parent path remains fail closed across later requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-start-parent-"));
  const parent = join(root, "not-directory");
  const broker = TurnBroker.forSocket(join(parent, "broker.sock"));
  try {
    writeFileSync(parent, "must remain");
    await expect(broker.listen()).rejects.toThrow();
    await expect(broker.listen()).rejects.toThrow();
    await broker.close();
    expect(existsSync(parent)).toBeTrue();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
