import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnCoordinator } from "../src/adapters/chatgpt-web/mcp/turn-coordinator";
import { RemoteTurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { runtimeIdentity } from "../src/runtime-identity";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native MCP refuses a stale broker protocol before claiming a turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-mcp-version-"));
  directories.push(directory);
  const socketPath = join(directory, "broker.sock");
  const methods: string[] = [];
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; method: string };
      methods.push(request.method);
      socket.end(`${JSON.stringify({ id: request.id, result: { protocolVersion: 5 } })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const coordinator = new TurnCoordinator(socketPath, "native");
    await expect(coordinator.claimTurn("codex_tool_call", "turn_test", {} as never)).rejects.toThrow(
      "protocol version",
    );
    expect(methods).toEqual(["owner_status"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("packaged native MCP refuses a broker from another build before claiming a turn", async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-mcp-build-"));
  directories.push(directory);
  const socketPath = join(directory, "broker.sock");
  const methods: string[] = [];
  const priorBuild = runtimeIdentity.buildCommit;
  runtimeIdentity.buildCommit = "a".repeat(40);
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; method: string };
      methods.push(request.method);
      socket.end(
        `${JSON.stringify({
          id: request.id,
          result: { protocolVersion: 6, identity: { buildCommit: "b".repeat(40) } },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const coordinator = new TurnCoordinator(socketPath, "native");
    await expect(coordinator.claimTurn("codex_tool_call", "turn_test", {} as never)).rejects.toThrow(
      /broker build.*MCP build/i,
    );
    expect(methods).toEqual(["owner_status"]);
  } finally {
    runtimeIdentity.buildCommit = priorBuild;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("packaged external owner refuses a broker from another build before registration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "external-owner-build-"));
  directories.push(directory);
  const socketPath = join(directory, "broker.sock");
  const methods: string[] = [];
  const priorBuild = runtimeIdentity.buildCommit;
  runtimeIdentity.buildCommit = "a".repeat(40);
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(String(chunk).trim()) as { id: string; method: string };
      methods.push(request.method);
      socket.end(
        `${JSON.stringify({
          id: request.id,
          result: {
            protocolVersion: 6,
            identity: { buildCommit: "b".repeat(40) },
            acceptingExternalOwners: true,
          },
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const owner = new RemoteTurnBroker(socketPath);
    await expect(owner.assertCompatible()).rejects.toThrow(/broker build.*owner build/i);
    expect(methods).toEqual(["owner_status"]);
  } finally {
    runtimeIdentity.buildCommit = priorBuild;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
