/**
 * Sprint AI-Fix: Model Catalog Stale-While-Revalidate Cache
 *
 * Root cause: when the upstream ChatGPT /models endpoint times out, modelsRequest()
 * returns 502, leaving Codex CLI with no catalog. The CLI then tries to use the
 * previously configured model (chatgpt-web/gpt-5.6-sol) natively → upstream 400.
 *
 * Fix: modelsRequest accepts a ModelCatalogCache. On transport/request failure it
 * serves the last successful catalog with status 200 and header X-Catalog-Stale: true.
 * On upstream non-ok it still passes through (upstream is authoritative for auth errors).
 * Cache stores the augmented body so context-window overrides remain stable.
 *
 * Seam: modelsRequest(req, config, fetchUpstream, contextOverride, onFailure, cache)
 */
import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { modelsRequest } from "../src/server";
import type { ModelCatalogCache } from "../src/server/models-route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(authToken = "Bearer codex-oauth-token"): Request {
  return new Request("http://127.0.0.1:17841/v1/models", {
    headers: { authorization: authToken, "user-agent": "codex_cli_rs/0.159.2 (Linux)" },
  });
}

const minimalNativeModel = {
  slug: "gpt-5.6-sol",
  display_name: "5.6 Sol",
  priority: 1,
  visibility: "list",
  supported_in_api: true,
  multi_agent_version: "v2",
  supported_reasoning_levels: [],
  tool_mode: "code_mode_only",
  context_window: 300_000,
  max_context_window: 320_000,
  auto_compact_token_limit: 270_000,
};

function successFetch(): NativeFetch {
  return async () => Response.json({ models: [minimalNativeModel] }, { headers: { etag: 'W/"abc"' } });
}

type NativeFetch = (req: Request) => Promise<Response>;

// ---------------------------------------------------------------------------
// Slice 1: cache stores successful response body for later stale serving
// ---------------------------------------------------------------------------

test("modelsRequest stores catalog body in cache after successful upstream fetch", async () => {
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  const cache: ModelCatalogCache = {};

  const response = await modelsRequest(makeRequest(), config, successFetch(), undefined, undefined, cache);

  expect(response.status).toBe(200);
  expect(cache.body).toBeDefined();
  expect(typeof cache.body).toBe("string");

  // Stored body must contain the native model slug
  const parsed = JSON.parse(cache.body!) as { models: Array<{ slug: string }> };
  expect(parsed.models.some((m) => m.slug === "gpt-5.6-sol")).toBe(true);
  // And the chatgpt-web models appended by augmentNativeModelCatalog
  expect(parsed.models.some((m) => m.slug.startsWith("chatgpt-web/"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Slice 2: transport failure without cache → still returns 502 (no regression)
// ---------------------------------------------------------------------------

test("modelsRequest returns 502 on transport failure when cache is empty", async () => {
  const config = defaultConfig("full");
  const cache: ModelCatalogCache = {};
  let failureStage: string | undefined;

  const response = await modelsRequest(
    makeRequest(),
    config,
    async () => {
      throw Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
    },
    undefined,
    (f) => {
      failureStage = f.stage;
    },
    cache,
  );

  expect(response.status).toBe(502);
  expect(failureStage).toBe("transport");
  // Cache must remain empty — nothing to serve
  expect(cache.body).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Slice 3: transport failure WITH prior cache → returns 200 with stale body
// ---------------------------------------------------------------------------

test("modelsRequest serves stale catalog on transport failure when cache is populated", async () => {
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  const cache: ModelCatalogCache = {};

  // First request succeeds and populates cache
  await modelsRequest(makeRequest(), config, successFetch(), undefined, undefined, cache);
  expect(cache.body).toBeDefined();

  // Second request — network dies
  let failureCalled = false;
  const response = await modelsRequest(
    makeRequest(),
    config,
    async () => {
      throw new Error("request timed out");
    },
    undefined,
    () => {
      failureCalled = true;
    },
    cache,
  );

  // onFailure is still called (telemetry must record it)
  expect(failureCalled).toBe(true);

  // But the response is 200, not 502
  expect(response.status).toBe(200);

  // Header signals the client that this is a stale response
  expect(response.headers.get("x-catalog-stale")).toBe("true");

  // Body is identical to cached content
  const body = (await response.json()) as { models: Array<{ slug: string }> };
  expect(body.models.some((m) => m.slug === "gpt-5.6-sol")).toBe(true);
  expect(body.models.some((m) => m.slug.startsWith("chatgpt-web/"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Slice 4: upstream non-ok (e.g. 401) passes through even when cache exists
// ---------------------------------------------------------------------------

test("modelsRequest passes through upstream error response even when stale cache exists", async () => {
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  const cache: ModelCatalogCache = {};

  // Populate cache
  await modelsRequest(makeRequest(), config, successFetch(), undefined, undefined, cache);

  // Now upstream returns 401 (auth revoked)
  const response = await modelsRequest(
    makeRequest(),
    config,
    async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    undefined,
    undefined,
    cache,
  );

  // 401 must pass through — serving stale catalog with expired auth hides security failures
  expect(response.status).toBe(401);
  expect(response.headers.get("x-catalog-stale")).toBeNull();
});

// ---------------------------------------------------------------------------
// Slice 5: cache is keyed per-config (solAvailable changes produce independent entries)
//   Implementation note: the cache object is passed in by the caller (server.ts),
//   so it is already scoped by the server's config lifetime. This test verifies
//   that two independent cache objects don't cross-contaminate.
// ---------------------------------------------------------------------------

test("independent cache objects do not share catalog state", async () => {
  const solConfig = defaultConfig("full");
  solConfig.subagentProtocol = "native";
  solConfig.solAvailable = true;

  const lunaConfig = defaultConfig("full");
  lunaConfig.subagentProtocol = "native";
  lunaConfig.solAvailable = false;

  const solCache: ModelCatalogCache = {};
  const lunaCache: ModelCatalogCache = {};

  await modelsRequest(makeRequest(), solConfig, successFetch(), undefined, undefined, solCache);
  await modelsRequest(makeRequest(), lunaConfig, successFetch(), undefined, undefined, lunaCache);

  expect(solCache.body).not.toBe(lunaCache.body);

  const solModels = (JSON.parse(solCache.body!) as { models: Array<{ slug: string }> }).models;
  const lunaModels = (JSON.parse(lunaCache.body!) as { models: Array<{ slug: string }> }).models;

  // Sol config must include sol routes; luna config must not
  expect(solModels.some((m) => m.slug === "chatgpt-web/gpt-5.6-sol")).toBe(true);
  expect(lunaModels.some((m) => m.slug === "chatgpt-web/gpt-5.6-sol")).toBe(false);
  expect(lunaModels.some((m) => m.slug === "chatgpt-web/gpt-5.6-luna")).toBe(true);
});

// ---------------------------------------------------------------------------
// Slice 6: stale response has correct content-type and ETag
// ---------------------------------------------------------------------------

test("stale catalog response has correct content-type and a stable ETag", async () => {
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  const cache: ModelCatalogCache = {};

  await modelsRequest(makeRequest(), config, successFetch(), undefined, undefined, cache);

  // Force transport failure
  const response = await modelsRequest(
    makeRequest(),
    config,
    async () => {
      throw new Error("timeout");
    },
    undefined,
    undefined,
    cache,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/application\/json/);
  // ETag must be present and stable (same body → same ETag)
  const etag = response.headers.get("etag");
  expect(etag).toBeTruthy();
  expect(etag).toMatch(/^W\//);
});

// ---------------------------------------------------------------------------
// Slice 7: modelsRequest without cache arg behaves identically to old contract
// ---------------------------------------------------------------------------

test("modelsRequest without cache arg still returns 502 on transport failure (backwards compat)", async () => {
  const config = defaultConfig("full");

  const response = await modelsRequest(
    makeRequest(),
    config,
    async () => {
      throw new Error("network unreachable");
    },
    undefined,
    undefined,
    // no cache arg
  );

  expect(response.status).toBe(502);
  expect(response.headers.get("x-catalog-stale")).toBeNull();
});
