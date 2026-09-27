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
  test("an unwritable telemetry destination does not fail a tool request", async () => {
    const { home, ws } = workspaceHome("telemetry-failure", { enabled: true, sandboxMode: "dangerFullAccess", workspaces: [] });
    writeFileSync(join(home, "logs"), "not a directory");
    writeFileSync(join(ws, "readable.txt"), "still readable");
    const { transport, client } = connectChatFirst(home);
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: "codex_read_file", arguments: { workspace: ws, path: "readable.txt" } });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ content: "still readable" });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  test("byte pagination round-trips Unicode over stdio and rejects mixed modes", async () => {
    const { home, ws } = workspaceHome("byte-pages", { enabled: true, sandboxMode: "dangerFullAccess", workspaces: [] });
    writeFileSync(join(ws, "unicode.txt"), "ab😀cdéfg");
    const { transport, client } = connectChatFirst(home);
    try {
      await client.connect(transport);
      let content = "";
      let offset = 0;
      for (let page = 0; page < 10; page += 1) {
        const res = await client.callTool({ name: "codex_read_file", arguments: {
          path: "unicode.txt", workspace: ws, max_bytes: 5, offset_bytes: offset,
        } });
        expect(res.isError).toBeUndefined();
        const data = res.structuredContent as any;
        expect(data.read_bytes).toBeLessThanOrEqual(5);
        content += data.content;
        if (data.next_offset_bytes === null) break;
        expect(data.next_offset_bytes).toBeGreaterThan(offset);
        offset = data.next_offset_bytes;
      }
      expect(content).toBe("ab😀cdéfg");
      const tracePath = join(home, "logs", "mcp", "telemetry.jsonl");
      const deadline = Date.now() + 3000;
      while ((!existsSync(tracePath) || !readFileSync(tracePath, "utf8").includes('"event":"reply_sent"')) && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      const events = readFileSync(tracePath, "utf8").trim().split("\n").map(line => JSON.parse(line));
      const reply = events.find(event => event.metadata?.event === "reply_sent");
      expect(reply).toBeDefined();
      expect(events.some(event => event.traceId === reply.traceId && event.metadata?.event === "call_received")).toBe(true);
      expect(JSON.stringify(events)).not.toContain("unicode.txt");
      expect(JSON.stringify(events)).not.toContain("ab😀cdéfg");
      const large = "line of evidence\n".repeat(5000);
      writeFileSync(join(ws, "large.txt"), large);
      const page = await client.callTool({ name: "codex_read_file", arguments: {
        path: "large.txt", workspace: ws, max_bytes: 100000,
      } });
      expect(page.isError).toBeUndefined();
      const textPart = (page.content as Array<{ type: string; text: string }>)[0];
      expect(JSON.parse(textPart.text).content).toBe(large);
      const mixed = await client.callTool({ name: "codex_read_file", arguments: {
        path: "unicode.txt", workspace: ws, max_bytes: 5, offset: 1,
      } });
      expect(mixed.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });

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

test("chat-first tasks are scoped by selected workspace and obey a shared concurrency cap", async () => {
  const home = makeHome("task-scopes", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const wsA = join(home, "a");
  const wsB = join(home, "b");
  mkdirSync(join(wsA, "sub"), { recursive: true });
  mkdirSync(wsB);
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.backgroundTasks = { maxConcurrent: 1, logRetentionHours: 48, resumeNotes: false };
  writeFileSync(configPath, JSON.stringify(config));
  const { client, transport } = connectChatFirst(home);
  let taskId: string | undefined;
  try {
    await client.connect(transport);
    const started = await client.callTool({
      name: "codex_exec",
      arguments: {
        workspace: wsA,
        workdir: "sub",
        background: true,
        cmd: process.platform === "win32" ? "cd & ping -n 6 127.0.0.1 > NUL" : "pwd; sleep 5",
      },
    });
    expect(started.isError).toBeUndefined();
    taskId = (started.structuredContent as { task_id: string }).task_id;
    const foreignList = await client.callTool({ name: "codex_poll_task", arguments: { workspace: wsB } });
    expect(foreignList.structuredContent).toMatchObject({ tasks: [] });
    const foreignKill = await client.callTool({
      name: "codex_poll_task",
      arguments: { workspace: wsB, task_id: taskId, kill: true },
    });
    expect(foreignKill.structuredContent).toMatchObject({ status: "not_found", killed: false });
    const foreignWait = await client.callTool({
      name: "codex_wait_tasks",
      arguments: { workspace: wsB, task_ids: [taskId], wait_ms: 100 },
    });
    expect(foreignWait.structuredContent).toMatchObject({ tasks: [{ status: "not_found" }] });
    const overLimit = await client.callTool({
      name: "codex_exec",
      arguments: { workspace: wsB, background: true, cmd: "echo should-not-start" },
    });
    expect(overLimit.isError).toBe(true);
    expect(JSON.stringify(overLimit.content)).toContain("maxConcurrent=1");
    const own = await client.callTool({
      name: "codex_poll_task",
      arguments: { workspace: wsA, task_id: taskId, wait_ms: 25 },
    });
    expect(own.structuredContent).toMatchObject({ status: "running" });
    expect((own.structuredContent as { output_tail: string }).output_tail).toContain(join(wsA, "sub"));
  } finally {
    if (taskId) {
      await client.callTool({ name: "codex_poll_task", arguments: { workspace: wsA, task_id: taskId, kill: true } });
      await client.callTool({ name: "codex_poll_task", arguments: { workspace: wsA, task_id: taskId, wait_ms: 2000 } });
    }
    await client.close();
  }
});

test("MCP cancellation terminates a foreground command before its delayed write", async () => {
  const { home, ws } = workspaceHome("foreground-cancel", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const { transport, client } = connectChatFirst(home);
  const controller = new AbortController();
  try {
    await client.connect(transport);
    const pending = client.callTool({
      name: "codex_exec",
      arguments: {
        workspace: ws,
        cmd: "printf ready > ready; sleep 2; printf late > late",
      },
    }, undefined, { signal: controller.signal }).catch(error => error);
    const deadline = Date.now() + 3000;
    while (!existsSync(join(ws, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(ws, "ready"))).toBe(true);
    controller.abort();
    await pending;
    await Bun.sleep(2200);
    expect(existsSync(join(ws, "late"))).toBe(false);
    const reply = await client.callTool({ name: "codex_exec", arguments: { workspace: ws, cmd: "printf alive" } });
    expect(reply.structuredContent).toMatchObject({ stdout: "alive", exit_code: 0 });
  } finally {
    controller.abort();
    await client.close();
  }
});

test("failed commands that changed files still appear in the audit log", async () => {
  const { home, ws } = workspaceHome("failed-command-audit", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const { transport, client } = connectChatFirst(home);
  try {
    await client.connect(transport);
    const cmd = "printf changed > changed; exit 7";
    const reply = await client.callTool({ name: "codex_exec", arguments: { workspace: ws, cmd } });
    expect(reply.isError).toBe(true);
    expect(readFileSync(join(ws, "changed"), "utf8")).toBe("changed");
    expect(existsSync(join(home, "runtime", "chat-first-audit.jsonl"))).toBe(true);
    expect(auditLines(home)).toContainEqual(expect.objectContaining({ tool: "codex_exec", path: cmd, detail: "error" }));
  } finally {
    await client.close();
  }
});

test("foreground and background execution share admission until process close", async () => {
  const { home, ws } = workspaceHome("shared-admission", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.backgroundTasks = { maxConcurrent: 1 };
  writeFileSync(configPath, JSON.stringify(config));
  const { transport, client } = connectChatFirst(home);
  const controller = new AbortController();
  try {
    await client.connect(transport);
    const foreground = client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, cmd: "printf ready > ready; sleep 3" },
    }, undefined, { signal: controller.signal }).catch(error => error);
    const deadline = Date.now() + 2000;
    while (!existsSync(join(ws, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(ws, "ready"))).toBe(true);
    const background = await client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf wrong > overflow" },
    });
    expect(background.isError).toBe(true);
    expect(existsSync(join(ws, "overflow"))).toBe(false);
    const queued = client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, cmd: "printf admitted > admitted" },
    });
    await Bun.sleep(60);
    expect(existsSync(join(ws, "admitted"))).toBe(false);
    controller.abort();
    await foreground;
    expect((await queued).isError).toBeUndefined();
    expect(readFileSync(join(ws, "admitted"), "utf8")).toBe("admitted");
  } finally {
    controller.abort();
    await client.close();
  }
});

test("independent MCP processes share one command capacity for the same home", async () => {
  const { home, ws } = workspaceHome("cross-process-admission", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.backgroundTasks = { maxConcurrent: 1 };
  writeFileSync(configPath, JSON.stringify(config));
  const first = connectChatFirst(home);
  const second = connectChatFirst(home);
  const childErrors: string[] = [];
  first.transport.stderr?.on("data", chunk => childErrors.push(String(chunk)));
  second.transport.stderr?.on("data", chunk => childErrors.push(String(chunk)));
  let taskId: string | undefined;
  try {
    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]).catch(error => {
      throw new Error(`${String(error)}\n${childErrors.join("")}`);
    });
    const started = await first.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf ready > ready; sleep 5" },
    });
    expect(started.isError).toBeUndefined();
    taskId = (started.structuredContent as { task_id: string }).task_id;
    const deadline = Date.now() + 2000;
    while (!existsSync(join(ws, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(ws, "ready"))).toBe(true);

    const overLimit = await second.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf overflow > overflow" },
    });
    expect(overLimit.isError).toBe(true);
    expect(existsSync(join(ws, "overflow"))).toBe(false);

    const queued = second.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, cmd: "printf admitted > admitted" },
    });
    await Bun.sleep(80);
    expect(existsSync(join(ws, "admitted"))).toBe(false);
    await first.client.callTool({
      name: "codex_poll_task",
      arguments: { workspace: ws, task_id: taskId, kill: true },
    });
    await first.client.callTool({
      name: "codex_poll_task",
      arguments: { workspace: ws, task_id: taskId, wait_ms: 2000 },
    });
    expect((await queued).isError).toBeUndefined();
    expect(readFileSync(join(ws, "admitted"), "utf8")).toBe("admitted");
  } finally {
    if (taskId) {
      await first.client.callTool({
        name: "codex_poll_task",
        arguments: { workspace: ws, task_id: taskId, kill: true },
      }).catch(() => {});
      await first.client.callTool({
        name: "codex_poll_task",
        arguments: { workspace: ws, task_id: taskId, wait_ms: 2000 },
      }).catch(() => {});
    }
    await Promise.all([
      first.client.close().catch(() => {}),
      second.client.close().catch(() => {}),
    ]);
  }
});

test("closing an MCP transport settles its running background task and frees the shared slot", async () => {
  const { home, ws } = workspaceHome("cross-process-close", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.backgroundTasks = { maxConcurrent: 1 };
  writeFileSync(configPath, JSON.stringify(config));
  const first = connectChatFirst(home);
  const second = connectChatFirst(home);
  try {
    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]);
    const started = await first.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf ready > ready; sleep 2; printf late > late" },
    });
    expect(started.isError).toBeUndefined();
    const deadline = Date.now() + 2000;
    while (!existsSync(join(ws, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(ws, "ready"))).toBe(true);
    await first.client.close();
    const admitted = await second.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, cmd: "printf after > after" },
    });
    expect(admitted.isError).toBeUndefined();
    expect(readFileSync(join(ws, "after"), "utf8")).toBe("after");
    await Bun.sleep(2200);
    expect(existsSync(join(ws, "late"))).toBe(false);
  } finally {
    await Promise.all([
      first.client.close().catch(() => {}),
      second.client.close().catch(() => {}),
    ]);
  }
});

test("an abruptly killed MCP owner cannot silently grant its potentially running slot", async () => {
  const { home, ws } = workspaceHome("cross-process-crash", {
    enabled: true,
    sandboxMode: "dangerFullAccess",
    workspaces: [],
  });
  const configPath = join(home, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.backgroundTasks = { maxConcurrent: 1 };
  writeFileSync(configPath, JSON.stringify(config));
  const first = connectChatFirst(home);
  const second = connectChatFirst(home);
  try {
    await Promise.all([
      first.client.connect(first.transport),
      second.client.connect(second.transport),
    ]);
    const started = await first.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf ready > ready; sleep 1; printf done > done" },
    });
    expect(started.isError).toBeUndefined();
    const deadline = Date.now() + 2000;
    while (!existsSync(join(ws, "ready")) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(existsSync(join(ws, "ready"))).toBe(true);
    const pid = first.transport.pid;
    expect(pid).not.toBeNull();
    process.kill(pid!, "SIGKILL");
    const rejected = await second.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, background: true, cmd: "printf overflow > overflow" },
    });
    expect(rejected.isError).toBe(true);
    expect(existsSync(join(ws, "overflow"))).toBe(false);
    const doneDeadline = Date.now() + 3000;
    while (!existsSync(join(ws, "done")) && Date.now() < doneDeadline) {
      await Bun.sleep(20);
    }
    expect(existsSync(join(ws, "done"))).toBe(true);

    const status = Bun.spawn([
      process.execPath, "src/cli.ts", "admission", "status", "--json",
    ], { cwd: process.cwd(), env: childEnv(home), stdout: "pipe", stderr: "pipe" });
    expect(await status.exited).toBe(0);
    const snapshot = JSON.parse(await new Response(status.stdout).text()) as {
      active: Array<{ id: number; ownerPid: number }>;
    };
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0]?.ownerPid).toBe(pid!);

    const recovered = Bun.spawn([
      process.execPath, "src/cli.ts", "admission", "recover", String(snapshot.active[0]!.id),
      "--ack-descendants-settled",
    ], { cwd: process.cwd(), env: childEnv(home), stdout: "pipe", stderr: "pipe" });
    expect(await recovered.exited).toBe(0);
    const admitted = await second.client.callTool({
      name: "codex_exec",
      arguments: { workspace: ws, cmd: "printf recovered > recovered" },
    });
    expect(admitted.isError).toBeUndefined();
    expect(readFileSync(join(ws, "recovered"), "utf8")).toBe("recovered");
  } finally {
    await Promise.all([
      first.client.close().catch(() => {}),
      second.client.close().catch(() => {}),
    ]);
  }
});
