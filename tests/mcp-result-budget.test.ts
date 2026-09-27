import { expect, test } from "bun:test";
import { asMcpResult } from "../src/adapters/chatgpt-web/mcp/results";

test("oversized structured output becomes an explicit error without partial JSON", () => {
  const res = asMcpResult({
    content: [{ type: "text", text: "done" }],
    structuredContent: { content: "界".repeat(400_000) },
  }, { offload: false });
  expect(res.isError).toBe(true);
  expect(res.structuredContent).toBeUndefined();
  const report = JSON.parse(res.content[0]!.text);
  expect(report.code).toBe("mcp_result_too_large");
  expect(report.retryable).toBe(false);
  expect(Buffer.byteLength(JSON.stringify(res))).toBeLessThan(1024);
});

test("metadata cannot bypass the serialized MCP result budget", () => {
  const res = asMcpResult({
    content: [{ type: "text", text: "done" }],
    _meta: { hidden: "x".repeat(2_000_000) },
  }, { offload: false });
  expect(res.isError).toBe(true);
  expect(res._meta).toBeUndefined();
  expect(JSON.parse(res.content[0]!.text).code).toBe("mcp_result_too_large");
});

test("bounded structured results preserve their schema and error flag", () => {
  const structuredContent = { rows: [{ id: 1, name: "sample" }], cursor: null };
  const res = asMcpResult({ content: [{ type: "text", text: "done" }], structuredContent });
  expect(res.structuredContent).toEqual(structuredContent);
  expect(res.isError).toBeUndefined();
});
