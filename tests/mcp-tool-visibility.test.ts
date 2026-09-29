import { expect, test } from "bun:test";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { BRIDGE_TOOL_NAMES, safeVisibleTools } from "../src/adapters/chatgpt-web/mcp/tool-visibility";

test("safe registry recognizes wait_tasks and hides its entire bridge namespace", () => {
  const environment: ChatGptTurnEnvironment = {
    cwd: "/workspace",
    roots: ["/workspace"],
    writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [
      { namespace: "bridge", name: "codex_wait_tasks", description: "Wait", parameters: {} },
      { namespace: "bridge", name: "future_bridge_tool", description: "Bridge", parameters: {} },
      { name: "facts_query", description: "Facts", parameters: {} },
    ],
  };
  expect(safeVisibleTools(environment, "safe").map((tool) => tool.name)).toEqual(["facts_query"]);
  expect(BRIDGE_TOOL_NAMES.has("codex_wait_tasks")).toBe(true);
  expect(safeVisibleTools(environment, "native")).toEqual(environment.tools);
});
