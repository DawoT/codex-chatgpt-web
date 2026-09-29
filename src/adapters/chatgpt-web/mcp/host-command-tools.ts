import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { workspaceFileCache } from "../fast-path-cache";
import { execCommandGatewayProgram } from "./gateway-programs";
import { afterSafeStart } from "./instructions";
import { exactTool, execGateway, turnReference, turnReferenceInput } from "./tool-visibility";
import type { TurnCoordinator } from "./turn-coordinator";

/** Host command transport: never starts a local shell or reads local task logs. */
export function registerHostCommandTools(server: McpServer, coordinator: TurnCoordinator): void {
  const contract = coordinator.contract;

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(
        contract,
        "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        background: z
          .boolean()
          .default(false)
          .optional()
          .describe("Unsupported for host-owned turns. Use yield_time_ms for native asynchronous command sessions."),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z
          .enum(["use_default", "require_escalated"])
          .optional()
          .describe(
            "Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve.",
          ),
        justification: z
          .string()
          .optional()
          .describe("Approval question for a native require_escalated request; omit otherwise."),
        prefix_rule: z
          .array(z.string())
          .optional()
          .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_exec", turnReference(contract, input), extra, async (claimed) => {
        const {
          cmd,
          workdir,
          background,
          yield_time_ms,
          max_output_tokens,
          tty,
          sandbox_permissions,
          justification,
          prefix_rule,
        } = input;
        const bound = claimed.environment;

        if (background) {
          throw new Error(
            "Background execution must be owned by the host. Use its supported command options; if it advertises native sessions, continue them with codex_write_stdin.",
          );
        }

        const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...permissions,
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          ...permissions,
        };
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        if (tool) {
          // Never silently discard an approval request on a native registry that cannot express it.
          const properties = tool.parameters.properties;
          for (const key of Object.keys(permissions)) {
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new Error(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          const res = await coordinator.invoke(
            claimed.bindingId,
            bound,
            tool,
            { arguments: args },
            extra.signal,
            requestedTimeoutMs,
          );
          workspaceFileCache.clear();
          return res;
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        const res = await coordinator.invoke(
          claimed.bindingId,
          bound,
          gateway,
          {
            input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
          },
          extra.signal,
          requestedTimeoutMs,
        );
        workspaceFileCache.clear();
        return res;
      }),
  );

  server.registerTool(
    "codex_wait_tasks",
    {
      title: "Wait for background tasks and return compact summaries",
      description: afterSafeStart(
        contract,
        "Legacy compatibility entry: bridge-local background tasks are unavailable to host-owned turns. Use codex_write_stdin for native command sessions.",
      ),
      inputSchema: {
        ...turnReferenceInput(contract),
        task_ids: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .describe("List of 1 to 10 background task IDs to wait for."),
        wait_ms: z
          .number()
          .int()
          .min(0)
          .max(90_000)
          .default(60_000)
          .optional()
          .describe("Milliseconds to wait for completion (clamped <= 90000, default 60000)."),
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(30)
          .optional()
          .describe("Trailing log lines to inspect for summarizing (default 30)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_wait_tasks", turnReference(contract, input), extra, async () => {
        throw new Error(
          "Background tasks belong to the host. Continue native command sessions with codex_write_stdin; bridge-local task IDs are unavailable.",
        );
      }),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) =>
      coordinator.withClaimedTurn("codex_write_stdin", turnReference(contract, input), extra, async (claimed) => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const requestedTimeoutMs = yield_time_ms !== undefined ? yield_time_ms + 15_000 : undefined;
        const tool = exactTool(bound, "write_stdin");
        const payload = {
          arguments: {
            session_id,
            ...(chars !== undefined ? { chars } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          },
        };
        const res = await (tool
          ? coordinator.invoke(claimed.bindingId, bound, tool, payload, extra.signal, requestedTimeoutMs)
          : coordinator.invokeNestedNative(
              claimed.bindingId,
              bound,
              "write_stdin",
              false,
              payload,
              extra.signal,
              requestedTimeoutMs,
            ));
        if (chars !== undefined) {
          workspaceFileCache.clear();
        }
        return res;
      }),
  );
}
