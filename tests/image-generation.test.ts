import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImage, type ImageGenerationRequest } from "../src/image-generation";

describe("Image Generation Service", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `image-gen-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 1x1 transparent PNG in base64
  const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  const samplePngBuffer = Buffer.from(samplePngBase64, "base64");

  test("generates an image and writes to specified outPath", async () => {
    const outPath = join(tempDir, "custom-image.png");
    let receivedUrl = "";
    let receivedAuth = "";
    let receivedBody: any = null;

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      receivedUrl = String(input);
      receivedAuth = (init?.headers as Record<string, string>)?.authorization || "";
      receivedBody = JSON.parse(String(init?.body || "{}"));

      return new Response(
        JSON.stringify({
          created: 1727500000,
          data: [{ b64_json: samplePngBase64 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await generateImage(
      {
        prompt: "A beautiful mountain sunset",
        size: "1024x1024",
        quality: "high",
        outPath,
        token: "test-oauth-token-123",
        baseUrl: "http://127.0.0.1:17841",
      },
      mockFetch as any,
    );

    expect(receivedUrl).toBe("http://127.0.0.1:17841/v1/images/generations");
    expect(receivedAuth).toBe("Bearer test-oauth-token-123");
    expect(receivedBody).toEqual({
      prompt: "A beautiful mountain sunset",
      size: "1024x1024",
      quality: "high",
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(outPath);
    expect(result.bytes).toBe(samplePngBuffer.length);
    expect(result.prompt).toBe("A beautiful mountain sunset");
    expect(result.size).toBe("1024x1024");
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath)).toEqual(samplePngBuffer);
  });

  test("saves image to CODEX_HOME/generated_images when outPath is omitted", async () => {
    const codexHome = join(tempDir, "mock-codex-home");
    mkdirSync(codexHome, { recursive: true });

    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          created: 1727500000,
          data: [{ b64_json: samplePngBase64 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const result = await generateImage(
      {
        prompt: "A cute golden retriever puppy",
        token: "test-token",
        codexHome,
      },
      mockFetch as any,
    );

    expect(result.success).toBe(true);
    expect(result.path.startsWith(join(codexHome, "generated_images"))).toBe(true);
    expect(result.path.endsWith(".png")).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path)).toEqual(samplePngBuffer);
  });

  test("throws validation error when prompt is empty", async () => {
    expect(
      generateImage({
        prompt: "   ",
        token: "test-token",
      }),
    ).rejects.toThrow("Prompt is required and cannot be empty");
  });

  test("throws error when upstream responds with failure status", async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          error: { message: "Quota exceeded or token expired" },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    };

    expect(
      generateImage(
        {
          prompt: "Valid prompt",
          token: "test-token",
        },
        mockFetch as any,
      ),
    ).rejects.toThrow("Image generation failed (HTTP 429): Quota exceeded or token expired");
  });
});
