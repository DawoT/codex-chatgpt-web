import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerImageTools } from "../src/adapters/chatgpt-web/mcp/image-tools";
import { BRIDGE_TOOL_NAMES } from "../src/adapters/chatgpt-web/mcp/tool-visibility";

describe("MCP Image Tools", () => {
  const samplePngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const samplePngBuffer = Buffer.from(samplePngBase64, "base64");

  test("registers codex_image_generate in MCP server and BRIDGE_TOOL_NAMES", async () => {
    expect(BRIDGE_TOOL_NAMES.has("codex_image_generate")).toBe(true);

    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerImageTools(server, {
      token: "test-token",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const imageTool = listed.tools.find((t) => t.name === "codex_image_generate");

    expect(imageTool).toBeDefined();
    expect(imageTool!.description).toContain("Generate an image");

    const schema = imageTool!.inputSchema as Record<string, any>;
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.properties.out_path).toBeDefined();
    expect(schema.properties.size).toBeDefined();
    expect(schema.properties.quality).toBeDefined();

    await client.close();
    await server.close();
  });

  test("executes codex_image_generate and saves image file", async () => {
    const tempDir = join(tmpdir(), `mcp-image-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const outPath = join(tempDir, "output.png");

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          created: 1727500000,
          data: [{ b64_json: samplePngBase64 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerImageTools(server, {
      token: "test-token",
      fetchImpl: mockFetch as any,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "codex_image_generate",
      arguments: {
        prompt: "A beautiful landscape",
        out_path: outPath,
        size: "1024x1024",
      },
    });

    expect(result.isError).toBeFalsy();
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath)).toEqual(samplePngBuffer);

    const textContent = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
    expect(textContent?.text).toContain(outPath);

    await client.close();
    await server.close();
    rmSync(tempDir, { recursive: true, force: true });
  });
});
