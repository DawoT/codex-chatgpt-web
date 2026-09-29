import { afterEach, expect, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { createRuntimeIdentity, runtimeIdentity } from "../src/runtime-identity";
import { type AdminRouteContext, handleAdminRoute } from "../src/server/admin-routes";

const roots: string[] = [];

async function healthDiagnostics(): Promise<Record<string, any>> {
  const ctx = {
    config: { controlToken: "secret", mode: "launcher", port: 12345 },
    startedAt: Date.now(),
    isDraining: () => false,
    activity: () => ({}),
    modelCatalogStats: {
      successfulModelCatalogRequests: 0,
      lastSuccessfulModelCatalogRequestAt: null,
      modelCatalogRequests: 0,
      lastModelCatalogResult: null,
    },
  } as unknown as AdminRouteContext;
  const request = new Request("http://localhost/healthz");
  const response = await handleAdminRoute(request, new URL(request.url), ctx);
  return (await response?.json()) as Record<string, any>;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("health diagnostics identify the running daemon generation and loaded artifact", async () => {
  const body = await healthDiagnostics();
  const identity = body.runtime_identity as Record<string, unknown>;
  expect(identity.protocolVersion).toBe(2);
  expect(identity.pid).toBe(process.pid);
  expect(identity.generation).toMatch(/^[a-f0-9-]{36}$/);
  expect(identity.artifactSha256).toBe(createHash("sha256").update(readFileSync(process.argv[1]!)).digest("hex"));
  expect((await healthDiagnostics()).runtime_identity.generation).toBe(identity.generation);
});

function helperClient(
  frame: Record<string, unknown> | "identified" | "tampered" | "previous" | "mismatched",
): LauncherBrowserHelperClient {
  const root = mkdtempSync(join(tmpdir(), "runtime-identity-helper-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  const helperSource =
    frame === "identified" || frame === "tampered" || frame === "previous" || frame === "mismatched"
      ? `
const { createHash, randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");
const identity = {
  protocolVersion: ${frame === "previous" ? 1 : 2},
  buildCommit: ${frame === "mismatched" ? JSON.stringify("b".repeat(40)) : JSON.stringify(runtimeIdentity.buildCommit)},
  artifactSha256: ${
    frame === "tampered"
      ? JSON.stringify("0".repeat(64))
      : 'createHash("sha256").update(readFileSync(process.argv[1])).digest("hex")'
  },
  generation: randomUUID(),
  pid: process.pid,
};
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: identity.protocolVersion, identity, features: [] }) + "\\n");
process.stdin.resume();
`
      : `
process.stdout.write(${JSON.stringify(`${JSON.stringify(frame)}\n`)});
process.stdin.resume();
`;
  writeFileSync(helper, helperSource);
  const descriptor = join(root, "launcher.json");
  writeFileSync(
    descriptor,
    JSON.stringify({
      version: 3,
      kind: LAUNCHER_BROWSER_HOST_KIND,
      profile: "production",
      pid: process.pid,
      endpoint: "http://127.0.0.1:39001",
      control: {
        endpoint: "http://127.0.0.1:39002",
        token: "launcher-control-token-0123456789abcdefghijklmnop",
      },
      helper: { executable: process.execPath, script: helper },
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "launcher_surface_id_0123456789AB",
      surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptor,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
    useSavedChats: false,
  });
}

test("a helper with an incompatible protocol is rejected at ready", async () => {
  const client = helperClient({ type: "ready", protocolVersion: 99, features: [] });
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(
      /incompatible helper protocol/i,
    );
  } finally {
    await client.close();
  }
});

test("a helper from the previous IPC generation cannot start a new session", async () => {
  const client = helperClient("previous");
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(
      /incompatible helper protocol/i,
    );
  } finally {
    await client.close();
  }
});

test("a legacy ready frame remains usable without an identity", async () => {
  const client = helperClient({ type: "ready", features: ["progress"] });
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).resolves.toBeUndefined();
    expect(client.getHelperIdentity()).toBeNull();
    expect(client.getHelperProtocolStatus()).toBe("legacy_unverified");
    expect((await healthDiagnostics()).helper_runtimes).toEqual([
      {
        pid: expect.any(Number),
        protocolStatus: "legacy_unverified",
        identity: null,
      },
    ]);
  } finally {
    await client.close();
  }
});

test("one helper exit leaves another helper's runtime identity in diagnostics", async () => {
  const first = helperClient("identified");
  const second = helperClient("identified");
  try {
    await (first as unknown as { ensureChild(): Promise<void> }).ensureChild();
    await (second as unknown as { ensureChild(): Promise<void> }).ensureChild();
    const secondIdentity = second.getHelperIdentity();
    expect(secondIdentity?.pid).toBeNumber();
    expect(secondIdentity?.generation).not.toBe(first.getHelperIdentity()?.generation);
    const firstChild = (first as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const exited = once(firstChild, "exit");
    firstChild.kill();
    await exited;
    expect(second.getHelperIdentity()).toEqual(secondIdentity);
    expect(second.getHelperProtocolStatus()).toBe("compatible");
    expect((await healthDiagnostics()).helper_runtimes).toEqual([
      {
        pid: secondIdentity?.pid,
        protocolStatus: "compatible",
        identity: secondIdentity,
      },
    ]);
  } finally {
    await first.close();
    await second.close();
  }
});

test("a matching build manifest supplies its commit while the artifact hash comes from disk", () => {
  const root = mkdtempSync(join(tmpdir(), "runtime-identity-manifest-"));
  roots.push(root);
  const app = join(root, "app");
  mkdirSync(app);
  const entrypoint = join(app, "cli.js");
  writeFileSync(entrypoint, "console.log('real bytes');\n");
  const hash = createHash("sha256").update(readFileSync(entrypoint)).digest("hex");
  const commit = "a".repeat(40);
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({
      buildCommit: commit,
      files: [{ path: "app/cli.js", sha256: hash }],
    }),
  );
  expect(createRuntimeIdentity(entrypoint)).toMatchObject({
    buildCommit: commit,
    artifactSha256: hash,
  });
  writeFileSync(entrypoint, "console.log('changed bytes');\n");
  const changed = createHash("sha256").update(readFileSync(entrypoint)).digest("hex");
  expect(createRuntimeIdentity(entrypoint)).toMatchObject({
    buildCommit: null,
    artifactSha256: changed,
  });
});

test("a versioned helper cannot omit its identity", async () => {
  const client = helperClient({ type: "ready", protocolVersion: 2, features: [] });
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(/identity/i);
  } finally {
    await client.close();
  }
});

test("a versioned helper cannot claim a hash other than its launched artifact", async () => {
  const client = helperClient("tampered");
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(
      /artifact hash/i,
    );
  } finally {
    await client.close();
  }
});

test("a packaged daemon rejects an identified helper from another build", async () => {
  const previous = runtimeIdentity.buildCommit;
  runtimeIdentity.buildCommit = "a".repeat(40);
  const client = helperClient("mismatched");
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(
      /helper build.*daemon build/i,
    );
  } finally {
    await client.close();
    runtimeIdentity.buildCommit = previous;
  }
});

test("a packaged daemon accepts a helper from the same build", async () => {
  const previous = runtimeIdentity.buildCommit;
  runtimeIdentity.buildCommit = "a".repeat(40);
  const client = helperClient("identified");
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).resolves.toBeUndefined();
  } finally {
    await client.close();
    runtimeIdentity.buildCommit = previous;
  }
});

test("a packaged daemon rejects a legacy helper without build identity", async () => {
  const previous = runtimeIdentity.buildCommit;
  runtimeIdentity.buildCommit = "a".repeat(40);
  const client = helperClient({ type: "ready", features: [] });
  try {
    await expect((client as unknown as { ensureChild(): Promise<void> }).ensureChild()).rejects.toThrow(
      /helper build.*daemon build/i,
    );
  } finally {
    await client.close();
    runtimeIdentity.buildCommit = previous;
  }
});
