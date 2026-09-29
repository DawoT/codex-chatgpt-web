import { expect, test } from "bun:test";
import { gatewayToolCatalogPage } from "../src/adapters/chatgpt-web/mcp/gateway-programs";

test("nested catalog refuses oversized UTF-8 payloads before interpreting JSON", () => {
  const text = JSON.stringify({
    total: 1,
    tools: [{ name: "facts_query", description: "界".repeat(360_000) }],
  });
  expect(text.length).toBeLessThan(1024 * 1024);
  expect(() => gatewayToolCatalogPage({ content: [{ type: "text", text }] }, new Set())).toThrow(
    "1 MiB response budget",
  );
});
