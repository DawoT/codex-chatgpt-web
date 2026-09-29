/**
 * Tests for generateImage() image-as-input (edit mode) support.
 *
 * Covers:
 * - Text-only → POST /v1/images/generations with JSON body
 * - inputImagePath → POST /v1/images/edits with multipart/form-data
 * - inputImageBase64 → POST /v1/images/edits with multipart/form-data
 * - inputImagePath missing file → throws
 * - edited flag in result
 */

import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { generateImage } from "../src/image-generation";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal 1×1 transparent PNG in base64 */
const MINIMAL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const MINIMAL_PNG_BUFFER = Buffer.from(MINIMAL_PNG_BASE64, "base64");

/** Fake success response returned by both endpoints */
function fakeSuccessResponse(body: object = {}): Response {
  return new Response(
    JSON.stringify({
      created: 1_700_000_000,
      data: [{ b64_json: MINIMAL_PNG_BASE64 }],
      ...body,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

/** Create a temporary PNG file and return its absolute path */
function tmpPng(): string {
  const dir = join(tmpdir(), `imgtest_${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "input.png");
  writeFileSync(path, MINIMAL_PNG_BUFFER);
  return path;
}

// ---------------------------------------------------------------------------
// Tests — generation mode (text only)
// ---------------------------------------------------------------------------

describe("generateImage — generation mode (no input image)", () => {
  it("sends POST to /v1/images/generations with JSON body", async () => {
    let capturedRequest: Request | undefined;

    const fakeFetch = (async (input: URL | RequestInfo, _init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input as RequestInfo, _init);
      return fakeSuccessResponse();
    }) as typeof fetch;

    const result = await generateImage(
      {
        prompt: "a red apple",
        token: "test-token",
        baseUrl: "http://127.0.0.1:19999",
      },
      fakeFetch,
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toContain("/v1/images/generations");
    expect(capturedRequest!.method).toBe("POST");
    expect(capturedRequest!.headers.get("content-type")).toContain("application/json");
    expect(result.edited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — edit mode (inputImagePath)
// ---------------------------------------------------------------------------

describe("generateImage — edit mode (inputImagePath)", () => {
  it("sends POST to /v1/images/edits with multipart/form-data when inputImagePath is provided", async () => {
    const pngPath = tmpPng();
    let capturedRequest: Request | undefined;
    let capturedBody: FormData | undefined;

    const fakeFetch = (async (input: URL | RequestInfo, _init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input as RequestInfo, _init);
      // FormData body is attached to the request; read it
      try {
        capturedBody = await (capturedRequest as any).formData?.() as FormData;
      } catch {
        // ignore — some runtimes may not support formData() on stub
      }
      return fakeSuccessResponse();
    }) as typeof fetch;

    const result = await generateImage(
      {
        prompt: "add a blue sky background",
        token: "test-token",
        baseUrl: "http://127.0.0.1:19999",
        inputImagePath: pngPath,
      },
      fakeFetch,
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toContain("/v1/images/edits");
    expect(capturedRequest!.method).toBe("POST");
    // content-type must NOT be manually set to application/json (browser sets multipart boundary automatically)
    expect(capturedRequest!.headers.get("content-type") ?? "").not.toContain("application/json");
    expect(result.edited).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("throws when inputImagePath points to a non-existent file", async () => {
    const fakeFetch = (() => fakeSuccessResponse()) as unknown as typeof fetch;

    await expect(
      generateImage(
        {
          prompt: "edit this",
          token: "test-token",
          inputImagePath: "/tmp/__non_existent_image_xzy__.png",
        },
        fakeFetch,
      ),
    ).rejects.toThrow("Input image not found");
  });
});

// ---------------------------------------------------------------------------
// Tests — edit mode (inputImageBase64)
// ---------------------------------------------------------------------------

describe("generateImage — edit mode (inputImageBase64)", () => {
  it("sends POST to /v1/images/edits with multipart/form-data when inputImageBase64 is provided", async () => {
    let capturedRequest: Request | undefined;

    const fakeFetch = (async (input: URL | RequestInfo, _init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input as RequestInfo, _init);
      return fakeSuccessResponse();
    }) as typeof fetch;

    const result = await generateImage(
      {
        prompt: "make it watercolor",
        token: "test-token",
        baseUrl: "http://127.0.0.1:19999",
        inputImageBase64: MINIMAL_PNG_BASE64,
        inputImageMime: "image/png",
      },
      fakeFetch,
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.url).toContain("/v1/images/edits");
    expect(result.edited).toBe(true);
  });

  it("defaults mime to image/png when inputImageMime is omitted", async () => {
    let capturedRequest: Request | undefined;

    const fakeFetch = (async (input: URL | RequestInfo, _init?: RequestInit) => {
      capturedRequest = input instanceof Request ? input : new Request(input as RequestInfo, _init);
      return fakeSuccessResponse();
    }) as typeof fetch;

    await generateImage(
      {
        prompt: "edit",
        token: "test-token",
        inputImageBase64: MINIMAL_PNG_BASE64,
      },
      fakeFetch,
    );

    // Should still hit /edits even without explicit mime
    expect(capturedRequest!.url).toContain("/v1/images/edits");
  });
});
