import { expect, test } from "bun:test";
import { catalogRouteDiagnostic } from "../src/doctor";

test("doctor reports a newer upstream catalog denial without exposing authorization", () => {
  const check = catalogRouteDiagnostic({
    last_successful_model_catalog_request_at: "2026-09-27T22:32:12.973Z",
    last_model_catalog_result: {
      at: "2026-09-27T22:32:31.125Z",
      status: 401,
      caller: { client: "other", bearerPresent: true },
      failure: { stage: "upstream" },
    },
  });
  expect(check).toMatchObject({ id: "codex-catalog", status: "warning" });
  expect(check?.message).toContain("401");
  expect(JSON.stringify(check)).not.toContain("Bearer");
});

test("doctor does not report an old failure after a successful catalog request", () => {
  expect(catalogRouteDiagnostic({
    last_successful_model_catalog_request_at: "2026-09-27T22:32:12.973Z",
    last_model_catalog_result: {
      at: "2026-09-27T22:28:00.929Z",
      status: 401,
      caller: { client: "other", bearerPresent: true },
      failure: { stage: "upstream" },
    },
  })).toBeUndefined();
});
