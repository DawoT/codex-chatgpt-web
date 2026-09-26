import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Chat-First MCP lifecycle: the token-free contract served by
// `codex-chatgpt-web mcp --contract chat-first`. The server reads its authority from the
// CODEX_CHATGPT_WEB_HOME config.json, never dials the turn broker, and audits successful
// mutations under runtime/chat-first-audit.jsonl.
setDefaultTimeout(30_000);

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const root = mkdtempSync(join(testTempRoot, "cgw-chat-first-mcp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function durableTrueBinary(): string {
  // parseConfig rejects ephemeral runtime commands; /bin/true exists on every supported CI host.
  for (const candidate of ["/bin/true", "/usr/bin/true"]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function childEnv(home: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    CODEX_CHATGPT_WEB_HOME: home,
  };
}

function writeChatFirstConfig(home: string, chatFirst: Record<string, unknown>): void {
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 3,
    releaseVersion: "chat-first-lifecycle-test",
    mode: "browser-only",
    subagentProtocol: "compatibility-v1",
    host: "127.0.0.1",
    port: 17_841,
    contextWindow: 256_000,
    appName: "Codex Native2",
    automaticAppName: "Codex Native2",
    manualAppName: "Codex Zero Risk",
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    chromeExecutablePath: "/usr/bin/google-chrome",
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: join(home, "runtime", "turn-broker.sock"),
    headed: true,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: false,
    experimentalSkillAttachments: false,
    experimentalFreshConversationPerTurn: false,
    useSavedChats: false,
    zeroRiskProEnabled: false,
    autoApproveToolCalls: false,
    controlToken: "chat_first_test_control_token_0123456789abcdefghij",
    runtimeCommand: [durableTrueBinary()],
    chatFirst,
  }, null, 2));
}

function makeHome(name: string, chatFirst: Record<string, unknown>): string {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  writeChatFirstConfig(home, chatFirst);
  return home;
}

function workspaceHome(name: string, chatFirst: Record<string, unknown>): { home: string; ws: string } {
  const home = makeHome(name, chatFirst);
  const ws = join(home, "ws");
  mkdirSync(ws, { recursive: true });
  return { home, ws };
}

function connectChatFirst(home: string): { transport: StdioClientTransport; client: Client } {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--contract", "chat-first"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: childEnv(home),
  });
  const client = new Client({ name: "codex-chat-first-contract-test", version: "1.0.0" });
  return { transport, client };
}

function auditLines(home: string): Array<Record<string, unknown>> {
  return readFileSync(join(home, "runtime", "chat-first-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("Chat-First MCP lifecycle", () => {
  test("dangerFullAccess serves six token-free tools, mutates the workspace, and audits mutations", async () => {
    const { home, ws } = workspaceHome("danger-full", {
      enabled: true,
      sandboxMode: "dangerFullAccess",
      workspaces: [],
    });
    writeFileSync(join(ws, "note.txt"), "alpha\nbeta", "utf8");
    const { transport, client } = connectChatFirst(home);
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("without any turn token");
      expect(client.getInstructions()).toContain("recorded in the local audit log");

      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_exec",
        "codex_grep",
        "codex_list_dir",
        "codex_patch_file",
        "codex_poll_task",
        "codex_read_file",
        "codex_tool_inventory",
        "codex_wait_tasks",
        "codex_write_file",
      ]);
      for (const tool of listed.tools) {
        const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
        expect(schema.required ?? []).not.toContain("turn_token");
        expect(schema.required ?? []).not.toContain("request_id");
        expect(JSON.stringify(schema.properties ?? {})).not.toContain("turn_token");
        expect(JSON.stringify(schema.properties ?? {})).not.toContain("request_id");
      }

      const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: {} });
      expect((inventory.structuredContent as Record<string, unknown>)).toMatchObject({
        contract: "chat-first",
        sandboxMode: "dangerFullAccess",
      });
      expect((inventory.structuredContent as { tools: unknown[] }).tools).toHaveLength(9);

      const read = await client.callTool({
        name: "codex_read_file",
        arguments: { path: join(ws, "note.txt"), workspace: ws },
      });
      expect(read.isError).toBeUndefined();
      expect(read.structuredContent).toMatchObject({ total_lines: 2, content: "alpha\nbeta" });

      const created = join(ws, "created.txt");
      const write = await client.callTool({
        name: "codex_write_file",
        arguments: { path: created, content: "hello chat-first\n", workspace: ws },
      });
      expect(write.isError).toBeUndefined();
      expect(existsSync(created)).toBe(true);

      const patch = await client.callTool({
        name: "codex_patch_file",
        arguments: {
          path: created,
          target_content: "chat-first",
          replacement_content: "chat-first-patched",
          workspace: ws,
        },
      });
      expect(patch.isError).toBeUndefined();
      expect(readFileSync(created, "utf8")).toBe("hello chat-first-patched\n");

      const executed = await client.callTool({
        name: "codex_exec",
        arguments: { cmd: "echo chat-first-shell-works", workspace: ws },
      });
      expect(executed.isError).toBeUndefined();
      expect(executed.structuredContent).toMatchObject({
        cmd: "echo chat-first-shell-works",
        exit_code: 0,
        timed_out: false,
      });
      expect((executed.structuredContent as { stdout: string }).stdout).toContain("chat-first-shell-works");

      const waitResult = await client.callTool({
        name: "codex_wait_tasks",
        arguments: { task_ids: ["non-existent-task-id"], wait_ms: 100 },
      });
      expect(waitResult.isError).toBeUndefined();
      expect(waitResult.structuredContent).toMatchObject({
        pending: 0,
        tasks: [{ task_id: "non-existent-task-id", status: "not_found" }],
      });

      const entries = auditLines(home);
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatchObject({
        tool: "codex_write_file",
        bytes: Buffer.byteLength("hello chat-first\n", "utf8"),
      });
      expect(entries[1]).toMatchObject({ tool: "codex_patch_file" });
      expect(entries[2]).toMatchObject({ tool: "codex_exec", path: "echo chat-first-shell-works" });
      for (const entry of entries) {
        expect(typeof entry.ts).toBe("string");
      }
    } finally {
      await client.close().catch(() => {});
    }
  });

  test("readOnly serves only the four read tools and no mutation tools", async () => {
    const { home } = workspaceHome("read-only", {
      enabled: true,
      sandboxMode: "readOnly",
      workspaces: [],
    });
    const { transport, client } = connectChatFirst(home);
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_grep",
        "codex_list_dir",
        "codex_read_file",
        "codex_tool_inventory",
      ]);
      const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: {} });
      expect(inventory.structuredContent).toMatchObject({
        contract: "chat-first",
        sandboxMode: "readOnly",
      });
      expect((inventory.structuredContent as { tools: unknown[] }).tools).toHaveLength(4);
    } finally {
      await client.close().catch(() => {});
    }
  });

  test("disabled chat-first fails closed before the MCP transport opens", async () => {
    const home = makeHome("disabled", {
      enabled: false,
      sandboxMode: "dangerFullAccess",
      workspaces: [],
    });
    const child = Bun.spawn([process.execPath, "src/cli.ts", "mcp", "--contract", "chat-first"], {
      cwd: process.cwd(),
      env: childEnv(home),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, , stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("chat-first is not enabled");
  });

  test("workspaceWrite confines mutations to the configured workspace", async () => {
    const home = join(root, "workspace-write");
    mkdirSync(home, { recursive: true });
    const ws = join(home, "ws");
    mkdirSync(ws, { recursive: true });
    writeChatFirstConfig(home, {
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [ws],
    });
    const outside = join(root, "outside-escape");
    mkdirSync(outside, { recursive: true });
    const { transport, client } = connectChatFirst(home);
    try {
      await client.connect(transport);
      const okTarget = join(ws, "ok.txt");
      const allowed = await client.callTool({
        name: "codex_write_file",
        arguments: { path: okTarget, content: "inside\n", workspace: ws },
      });
      expect(allowed.isError).toBeUndefined();
      expect(existsSync(okTarget)).toBe(true);

      const escapeTarget = join(outside, "escape.txt");
      const rejected = await client.callTool({
        name: "codex_write_file",
        arguments: { path: escapeTarget, content: "outside\n", workspace: outside },
      });
      expect(rejected.isError).toBe(true);
      expect(existsSync(escapeTarget)).toBe(false);

      // The rejected mutation must not reach the audit log.
      expect(auditLines(home)).toHaveLength(1);
      expect(auditLines(home)[0]).toMatchObject({ tool: "codex_write_file" });
    } finally {
      await client.close().catch(() => {});
    }
  });
});
