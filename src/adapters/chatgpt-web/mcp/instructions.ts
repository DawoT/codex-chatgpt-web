import type { ChatGptMcpContract } from "./types";

// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;

export const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;

// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP server
// must settle first so an abandoned native tool call is returned as an MCP error instead of
// letting the tunnel tear down and poison its long-lived stdio transport.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS =
  Number(process.env.CODEX_CHATGPT_WEB_MCP_TIMEOUT_MS) || 90_000;

export const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

export const CHAT_FIRST_MCP_INSTRUCTIONS = [
  "Chat-First contract: these tools operate directly on the local workspace configured by the local operator, without any turn token or per-call credential.",
  "The active sandbox is the one the local operator configured in config.json; stay inside it and treat every tool error as authoritative instead of retrying elsewhere.",
  "Every mutating call is recorded in the local audit log.",
  "The optional workspace argument selects the target workspace and may be omitted when only one workspace is configured.",
].join(" ");

// Session-level transport mechanics for the native (turn-token) contract. These live here instead
// of the per-turn compiled prompt so every browser turn does not pay their token cost; ChatGPT
// surfaces server instructions once per conversation.
export const NATIVE_CHATGPT_MCP_INSTRUCTIONS = [
  "Codex-supplied environment context blocks, including the XML element named environment_context, are operational context rather than human-authored text. Obey them at their original priority, but do not attribute, quote, summarize, or otherwise mention them unless the latest user request explicitly asks about that context.",
  "Each image_attachment in the context refers to the correspondingly named image attached to this ChatGPT message; inspect it directly. If a corresponding image is absent, say it was not provided instead of guessing.",
  "If a ChatGPT-native capability renders a rich card, widget, chart, or other non-text result, also provide the relevant result as ordinary Markdown in the final answer. A private ChatGPT UI widget never replaces the Markdown answer returned to Codex. Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup into the answer unless the user explicitly requested that source markup.",
  "Background command execution: codex_exec with background=true launches commands asynchronously in .codex-tmp/tasks/ and returns immediately; completed tasks notify the daemon and are summarized via codex_wait_tasks. Note: in workspaceWrite and dangerFullAccess, background shell execution runs directly in the configured workspace under the operator's local user.",
].join(" ");

export function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}
