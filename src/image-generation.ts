import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface ImageGenerationRequest {
  prompt: string;
  size?: "1024x1024" | "1536x1024" | "1024x1536" | "auto" | string;
  quality?: "low" | "medium" | "high" | "auto" | string;
  outPath?: string;
  token?: string;
  baseUrl?: string;
  codexHome?: string;
}

export interface ImageGenerationResult {
  success: boolean;
  path: string;
  bytes: number;
  prompt: string;
  size: string;
  created: number;
}

/**
 * Resolves the active Codex auth token.
 * Checks, in order:
 * 1. Explicitly passed token
 * 2. process.env.CODEX_AUTH_TOKEN
 * 3. ~/.codex/auth.json (ChatGPT Plus OAuth tokens.access_token or OPENAI_API_KEY)
 * 4. process.env.OPENAI_API_KEY
 */
export function resolveAuthToken(explicitToken?: string, codexHome?: string): string | undefined {
  if (explicitToken?.trim()) return explicitToken.trim();
  if (process.env.CODEX_AUTH_TOKEN?.trim()) return process.env.CODEX_AUTH_TOKEN.trim();

  const home = codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
  const authFile = join(home, "auth.json");
  if (existsSync(authFile)) {
    try {
      const parsed = JSON.parse(readFileSync(authFile, "utf8"));
      if (typeof parsed?.tokens?.access_token === "string" && parsed.tokens.access_token.trim()) {
        return parsed.tokens.access_token.trim();
      }
      if (typeof parsed?.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.trim()) {
        return parsed.OPENAI_API_KEY.trim();
      }
    } catch {
      // Fall through to environment variables if file parsing fails.
    }
  }

  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  return undefined;
}

/**
 * Generates an image using the local bridge image generation endpoint or upstream backend.
 */
export async function generateImage(
  request: ImageGenerationRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageGenerationResult> {
  const prompt = request.prompt?.trim();
  if (!prompt) {
    throw new Error("Prompt is required and cannot be empty");
  }

  const token = resolveAuthToken(request.token, request.codexHome);
  if (!token) {
    throw new Error(
      "No authorization token found. Ensure ~/.codex/auth.json contains active tokens or set CODEX_AUTH_TOKEN/OPENAI_API_KEY.",
    );
  }

  const baseUrl = (request.baseUrl || "http://127.0.0.1:17841").replace(/\/+$/, "");
  const endpointUrl = `${baseUrl}/v1/images/generations`;

  const size = request.size || "1024x1024";
  const quality = request.quality || "auto";

  const payload: Record<string, unknown> = {
    prompt,
    size,
    quality,
  };

  const response = await fetchImpl(endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorDetail = response.statusText;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) {
        errorDetail = errJson.error.message;
      } else if (typeof errJson?.message === "string") {
        errorDetail = errJson.message;
      }
    } catch {
      // Keep default statusText if response is not JSON
    }
    throw new Error(`Image generation failed (HTTP ${response.status}): ${errorDetail}`);
  }

  const data = (await response.json()) as {
    created?: number;
    data?: Array<{ b64_json?: string; url?: string }>;
  };

  const imageItem = data.data?.[0];
  if (!imageItem?.b64_json && !imageItem?.url) {
    throw new Error("Upstream response did not contain image data (expected b64_json or url)");
  }

  let imageBuffer: Buffer;
  if (imageItem.b64_json) {
    imageBuffer = Buffer.from(imageItem.b64_json, "base64");
  } else {
    // If URL is returned, fetch the binary
    const imgFetch = await fetchImpl(imageItem.url!);
    if (!imgFetch.ok) {
      throw new Error(`Failed to download generated image from ${imageItem.url}`);
    }
    imageBuffer = Buffer.from(await imgFetch.arrayBuffer());
  }

  // Determine save path
  let targetPath = request.outPath;
  if (!targetPath) {
    const codexHome = request.codexHome || process.env.CODEX_HOME || join(homedir(), ".codex");
    const dateStr = new Date().toISOString().slice(0, 10);
    const targetDir = join(codexHome, "generated_images", dateStr);
    mkdirSync(targetDir, { recursive: true });
    targetPath = join(targetDir, `image_${Date.now()}_${randomUUID().slice(0, 8)}.png`);
  } else {
    targetPath = resolve(targetPath);
    mkdirSync(dirname(targetPath), { recursive: true });
  }

  writeFileSync(targetPath, imageBuffer);

  return {
    success: true,
    path: targetPath,
    bytes: imageBuffer.length,
    prompt,
    size,
    created: data.created || Math.floor(Date.now() / 1000),
  };
}
