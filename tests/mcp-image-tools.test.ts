import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHostRegistryTools } from "../src/adapters/chatgpt-web/mcp/host-registry-tools";
import { registerImageTools } from "../src/adapters/chatgpt-web/mcp/image-tools";
import { BRIDGE_TOOL_NAMES } from "../src/adapters/chatgpt-web/mcp/tool-visibility";
import { TurnCoordinator } from "../src/adapters/chatgpt-web/mcp/turn-coordinator";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

describe("MCP Image Tools", () => {
  const samplePngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const samplePngBuffer = Buffer.from(samplePngBase64, "base64");

  test("missing runtime contract rejects before either image alias is registered", async () => {
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    server.registerTool("existing-tool", { inputSchema: {} }, async () => ({ content: [] }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    let registrationError: unknown;
    try {
      try {
        Reflect.apply(registerImageTools, undefined, [server, {}]);
      } catch (error) {
        registrationError = error;
      }
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["existing-tool"]);
      expect(registrationError).toBeInstanceOf(Error);
      expect((registrationError as Error).message).toMatch(/contract/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("registers codex_image_generate and image_gen in MCP server and BRIDGE_TOOL_NAMES", async () => {
    expect(BRIDGE_TOOL_NAMES.has("codex_image_generate")).toBe(true);
    expect(BRIDGE_TOOL_NAMES.has("image_gen")).toBe(true);

    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerImageTools(server, {
      contract: "native",
      token: "test-token",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const imageTool = listed.tools.find((t) => t.name === "codex_image_generate");
    const imageGenTool = listed.tools.find((t) => t.name === "image_gen");

    expect(imageTool).toBeDefined();
    expect(imageTool!.description).toContain("Generate an image");
    expect(imageGenTool).toBeDefined();
    expect(imageGenTool!.description).toContain("Generate an image");

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
      contract: "native",
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

  test("executes image_gen alias and saves image file", async () => {
    const tempDir = join(tmpdir(), `mcp-image-alias-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const outPath = join(tempDir, "alias_output.png");

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
      contract: "native",
      token: "test-token",
      fetchImpl: mockFetch as any,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "image_gen",
      arguments: {
        prompt: "A pottery vase with Warpa iconography",
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

  test("codex_tool_inventory discovers codex_image_generate and image_gen", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "mcp-inv-img-"));
    const socket = join(cwd, "broker.sock");
    const broker = TurnBroker.forSocket(socket);
    const token = await broker.register({
      cwd,
      roots: [cwd],
      writableRoots: [cwd],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [{ name: "exec", description: "execute command", parameters: {} }],
    });

    const coordinator = new TurnCoordinator(socket, "native");
    const server = new McpServer({ name: "test-server", version: "1.0.0" });
    registerHostRegistryTools(server, coordinator);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const res = await client.callTool({
      name: "codex_tool_inventory",
      arguments: {
        turn_token: token,
        query: "image",
      },
    });

    expect(res.isError).toBeFalsy();
    const textContent = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text");
    expect(textContent?.text).toBeDefined();
    const parsed = JSON.parse(textContent!.text!);
    const toolNames = parsed.tools.map((t: any) => t.name);
    expect(toolNames).toContain("codex_image_generate");
    expect(toolNames).toContain("image_gen");

    await client.close();
    await server.close();
    broker.close();
    rmSync(cwd, { recursive: true, force: true });
  });
});
