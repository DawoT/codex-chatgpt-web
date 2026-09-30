import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import type { CodexModelContextOverride } from "../codex-integration";
import type { AppConfig } from "../config";
import { augmentNativeModelCatalog } from "../model-catalog";
import { fetchNativeCodex } from "../native-network";
import { codexClientVersionFromUserAgent, forwardNativeCodexRequest, type NativeFetch } from "../native-passthrough";

export interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

export function modelCatalogClient(request: Request): {
  client: "codex" | "other";
  version?: string;
  bearerPresent: boolean;
} {
  const version = codexClientVersionFromUserAgent(request.headers.get("user-agent"));
  const authorization = request.headers.get("authorization") ?? "";
  return {
    client: version ? "codex" : "other",
    ...(version ? { version } : {}),
    bearerPresent: authorization.startsWith("Bearer ") && authorization.length > 7,
  };
}

export function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  return { stage, ...(typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? { code } : {}) };
}

/**
 * Mutable cache bucket passed by server.ts into modelsRequest.
 * Holds the last successfully augmented catalog body (JSON string) and its ETag.
 * Scoped to a single server instance so it is naturally per-config.
 */
export interface ModelCatalogCache {
  body?: string;
  etag?: string;
}

function buildStaleResponse(cache: ModelCatalogCache): Response {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("x-catalog-stale", "true");
  if (cache.etag) headers.set("etag", cache.etag);
  return new Response(cache.body, { status: 200, headers });
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
  cache?: ModelCatalogCache,
): Promise<Response> {
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", (input) => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    const failure = modelCatalogFailure(sent ? "transport" : "request", error);
    onFailure?.(failure);
    // Serve stale catalog if available — prevents 502 from leaving CLI model-less
    if (cache?.body) return buildStaleResponse(cache);
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    onFailure?.({ stage: "upstream" });
    return upstream;
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    onFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const etag = `W/"${createHash("sha256").update(body).digest("base64url")}"`;
  // Update cache on every success
  if (cache) {
    cache.body = body;
    cache.etag = etag;
  }
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", etag);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}
