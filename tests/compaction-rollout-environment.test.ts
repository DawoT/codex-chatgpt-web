import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { parseRequest } from "../src/responses/parser";
import type { CodexTool } from "../src/types";

const root = resolve(process.cwd());
const threadId = "01a0ebed-a0a6-7b62-bc68-20e710bd983b";
const userTurnId = "01a0ec01-0000-7000-8000-000000000001";
const intermediateTurnId = "01a0ec02-0000-7000-8000-000000000002";
const compactTurnId = "01a0ec03-0000-7000-8000-000000000003";

function setupRolloutFixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-rollout-compaction-"));
  const sqliteHome = join(codexHome, "state");
  mkdirSync(sqliteHome, { recursive: true });

  const rolloutPath = join(
    codexHome,
    "sessions",
    "2026",
    "09",
    "29",
    `rollout-2026-09-29T02-00-00-${threadId}.jsonl`,
  );
  mkdirSync(dirname(rolloutPath), { recursive: true });

  // Rollout records: session_meta and the latest executed tool turn (intermediateTurnId)
  const sessionMeta = {
    type: "session_meta",
    payload: {
      id: threadId,
      source: "vscode",
    },
  };

  const intermediateTurnContext = {
    type: "turn_context",
    payload: {
      turn_id: intermediateTurnId,
      cwd: root,
      workspace_roots: [root],
      permission_profile: { type: "disabled" },
      sandbox_policy: { type: "danger-full-access" },
    },
  };

  writeFileSync(
    rolloutPath,
    [JSON.stringify(sessionMeta), JSON.stringify(intermediateTurnContext)].join("\n") + "\n",
  );

  // Setup state_5.sqlite
  const db = new Database(join(sqliteHome, "state_5.sqlite"));
  db.run(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      agent_path TEXT
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT,
      child_thread_id TEXT,
      status TEXT
    );
  `);
  db.run(
    "INSERT INTO threads (id, rollout_path, agent_path) VALUES (?, ?, ?)",
    [threadId, rolloutPath, "/root"],
  );
  db.close();

  return {
    codexHome,
    sqliteHome,
    rolloutPath,
    cleanup: () => rmSync(codexHome, { recursive: true, force: true }),
  };
}

function createCompactionRequest(tools: CodexTool[] = []): ReturnType<typeof parseRequest> {
  const environmentXml = `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`;
  const wire = {
    model: "chatgpt-web/pro",
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        id: "msg_preamble",
        content: [{ type: "input_text", text: environmentXml }],
        internal_chat_message_metadata_passthrough: { turn_id: userTurnId },
      },
      {
        type: "message",
        role: "user",
        id: "msg_user_prompt",
        content: [{ type: "input_text", text: "Please refactor the module" }],
        internal_chat_message_metadata_passthrough: { turn_id: userTurnId },
      },
      {
        type: "function_call",
        id: "call_tool_1",
        call_id: "call_1",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun test" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Tests passed",
        internal_chat_message_metadata_passthrough: { turn_id: intermediateTurnId },
      },
      {
        type: "compaction_trigger",
      },
    ],
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        turn_id: compactTurnId,
        agent_name: "/root",
        sandbox: "none",
        workspaces: { [root]: {} },
        request_kind: "compaction",
      }),
    },
    tools,
  };

  const parsed = parseRequest(wire);
  parsed._compactionRequest = true;
  return parsed;
}

describe("Compaction rollout environment resolution", () => {
  test("resolves environment for a compaction request when the rollout latest turn is an intermediate executed turn", () => {
    const fixture = setupRolloutFixture();
    try {
      const store = new ChatGptThreadEnvironmentStore(
        undefined,
        Date.now,
        fixture.codexHome,
        fixture.sqliteHome,
      );
      const compactionRequest = createCompactionRequest();

      // This must successfully resolve the environment from the thread's authoritative rollout
      // rather than throwing "Latest Codex rollout turn context does not belong to the requested turn"
      const environment = store.resolve(compactionRequest);
      expect(environment).toBeDefined();
      expect(environment.cwd).toBe(root);
      expect(environment.roots).toEqual([root]);
      expect(environment.sandboxPolicy.type).toBe("dangerFullAccess");
    } finally {
      fixture.cleanup();
    }
  });

  test("falls back to cached sameThread environment during compaction if rollout turn context has advanced", () => {
    const fixture = setupRolloutFixture();
    try {
      const store = new ChatGptThreadEnvironmentStore(
        undefined,
        Date.now,
        fixture.codexHome,
        fixture.sqliteHome,
      );

      // Seed the cache with the thread's environment from an earlier turn via public API
      const initialRequest = parseRequest({
        model: "chatgpt-web/pro",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            id: "msg_initial",
            content: [{
              type: "input_text",
              text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`,
            }],
            internal_chat_message_metadata_passthrough: { turn_id: userTurnId },
          },
          {
            type: "message",
            role: "user",
            id: "msg_user",
            content: [{ type: "input_text", text: "Start task" }],
            internal_chat_message_metadata_passthrough: { turn_id: userTurnId },
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: threadId,
            turn_id: userTurnId,
            agent_name: "/root",
            sandbox: "none",
            workspaces: { [root]: {} },
            request_kind: "turn",
          }),
        },
      });
      store.resolve(initialRequest);

      const compactionRequest = createCompactionRequest();
      const environment = store.resolve(compactionRequest);
      expect(environment).toBeDefined();
      expect(environment.cwd).toBe(root);
    } finally {
      fixture.cleanup();
    }
  });
});
