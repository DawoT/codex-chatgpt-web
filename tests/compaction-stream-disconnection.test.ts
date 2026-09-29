import { describe, expect, it } from "bun:test";
import { validateCompactionQuality } from "../src/adapters/chatgpt-web/autonomous-compaction";
import { canonicalizeCompactionHandoff } from "../src/adapters/chatgpt-web/compaction-handoff";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent, CodexMessage, CodexParsedRequest } from "../src/types";

describe("Compaction Stream Disconnection & Checkpoint Validation Diagnostics", () => {
  const samplePatchedMessages: CodexMessage[] = [
    {
      role: "user",
      content: "Actualizar catalogo y scripts de importacion",
      timestamp: 1000,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_patch_1",
          name: "apply_patch",
          arguments: { patch: "*** update ***" },
        },
      ],
      timestamp: 1001,
    },
    {
      role: "toolResult",
      toolCallId: "call_patch_1",
      toolName: "apply_patch",
      content: [
        "Success.",
        "M /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs",
        "A /home/deuz/projects/Allpa Craft/.agents/scratch/build_pillaca_catalog.py",
        "M /home/deuz/projects/Allpa Craft/docs/catalog/TALLER_PILLACA.md",
        "A /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-premium-sample.py",
        "A /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-rembg-sample.py",
      ].join("\n"),
      isError: false,
      timestamp: 1002,
    },
  ];

  describe("Validation Failure Diagnostics (Exact User Error Scenario)", () => {
    it("detects when model outputs an empty or malformed XML block missing all mandatory sections and modified files", () => {
      // The model emits the tags but none of the required v2 checklist sections
      const emptyXmlBlock = [
        "Summary of work so far:",
        "<compaction_state>",
        "</compaction_state>",
      ].join("\n");

      const verdict = validateCompactionQuality(samplePatchedMessages, emptyXmlBlock, {
        requireStructured: true,
      });

      expect(verdict.valid).toBe(false);
      // All the exact invariants reported in the user's error message:
      expect(verdict.missingInvariants).toContain("Missing active objective or hypothesis");
      expect(verdict.missingInvariants).toContain("Checkpoint requires mission checklist version 2");
      expect(verdict.missingInvariants).toContain("Missing mission requirements");
      expect(verdict.missingInvariants).toContain("Missing closure criteria");
      expect(verdict.missingInvariants).toContain("Checkpoint requires one clear next action");
      expect(verdict.missingInvariants).toContain("Missing modified_files section");
      expect(verdict.missingInvariants).toContain("Missing requirements section");
      expect(verdict.missingInvariants).toContain("Missing closure_criteria section");
      expect(verdict.missingInvariants).toContain("Missing verified_achievements section");
      expect(verdict.missingInvariants).toContain("Missing decisions_and_invariants section");
      expect(verdict.missingInvariants).toContain("Missing blockers_or_test_failures section");
      expect(verdict.missingInvariants).toContain("Missing pending_obligations section");
      expect(verdict.missingInvariants).toContain("Missing next_actions section");

      // And specifically the modified files detected from tool patches:
      expect(verdict.missingInvariants).toContain(
        "Missing modified file from successful patch: /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs",
      );
      expect(verdict.missingInvariants).toContain(
        "Missing modified file from successful patch: /home/deuz/projects/Allpa Craft/.agents/scratch/build_pillaca_catalog.py",
      );
      expect(verdict.missingInvariants).toContain(
        "Missing modified file from successful patch: /home/deuz/projects/Allpa Craft/docs/catalog/TALLER_PILLACA.md",
      );
      expect(verdict.missingInvariants).toContain(
        "Missing modified file from successful patch: /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-premium-sample.py",
      );
      expect(verdict.missingInvariants).toContain(
        "Missing modified file from successful patch: /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-rembg-sample.py",
      );
    });

    it("detects when upstream stream cuts off prematurely mid-checkpoint generation", () => {
      // Model stream interrupted while writing the state
      const truncatedStreamText = [
        "Handoff summary for continuation:",
        "<compaction_state>",
        "version: 2",
        "original_request_ref: user request 1",
        // Stream dropped here without closing tag or remaining sections
      ].join("\n");

      const verdict = validateCompactionQuality(samplePatchedMessages, truncatedStreamText, {
        requireStructured: true,
      });

      expect(verdict.valid).toBe(false);
      // Because opening tag was never closed, structured state is unparseable
      expect(verdict.missingInvariants).toContain("Missing structured compaction state");
    });

    it("detects when upstream model outputs plain narrative markdown instead of structured XML", () => {
      const narrativeOnly = [
        "## Summary of Progress",
        "We successfully updated the catalog files and sample scripts.",
        "- Edited import-catalog-csv.mjs",
        "- Created build_pillaca_catalog.py",
        "Next steps: Continue testing the catalog pipeline.",
      ].join("\n");

      const verdict = validateCompactionQuality(samplePatchedMessages, narrativeOnly, {
        requireStructured: true,
      });

      expect(verdict.valid).toBe(false);
      expect(verdict.missingInvariants).toContain("Missing structured compaction state");
    });

    it("passes when the model satisfies all v2 sections and includes all modified files", () => {
      const validCompleteCheckpoint = [
        "Completed initial catalog setup.",
        "<compaction_state>",
        "version: 2",
        "original_request_ref: Actualizar catalogo y scripts de importacion",
        "modified_files:",
        "- /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/build_pillaca_catalog.py",
        "- /home/deuz/projects/Allpa Craft/docs/catalog/TALLER_PILLACA.md",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-premium-sample.py",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-rembg-sample.py",
        "active_hypothesis: Complete catalog import scripts and verify generated outputs.",
        "requirements:",
        '- {"id":"REQ-1","status":"pending","source":"Actualizar catalogo"}',
        "closure_criteria:",
        "- All catalog scripts run without errors",
        "verified_achievements:",
        "decisions_and_invariants:",
        "- Keep sample files under .agents/scratch/",
        "blockers_or_test_failures:",
        "- None",
        "pending_obligations:",
        "- Run catalog build script",
        "next_actions:",
        "- Run catalog build script",
        "</compaction_state>",
      ].join("\n");

      const verdict = validateCompactionQuality(samplePatchedMessages, validCompleteCheckpoint, {
        requireStructured: true,
      });

      expect(verdict.valid).toBe(true);
      expect(verdict.missingInvariants).toHaveLength(0);
    });
  });

  describe("SSE Transport Behavior on Validation Failure vs Codex Disconnection", () => {
    it("verifies why Codex CLI reports 'stream disconnected before completion' upon 409 rejection", async () => {
      const validationErrorMessage =
        "Context checkpoint failed validation: Missing active objective or hypothesis; Checkpoint requires mission checklist version 2";

      async function* validationFailedEventStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "heartbeat" };
        yield {
          type: "milestone",
          kind: "intervention_required",
          result: "Checkpoint rejected",
          evidence: "context_checkpoint_validation_failed",
          nextStep: "Review the checkpoint and retry compaction explicitly",
        };
        yield {
          type: "error",
          message: validationErrorMessage,
          status: 409,
          errorType: "invalid_response_error",
          code: "context_checkpoint_validation_failed",
          retryable: false,
        };
      }

      const stream = bridgeToResponsesSSE(
        validationFailedEventStream(),
        "chatgpt-web/high",
        undefined,
        undefined,
        undefined,
        undefined,
        10_000,
        { compaction: true },
      );

      const responseText = await new Response(stream).text();

      // 1. The bridge emits the milestone explaining intervention is required
      expect(responseText).toContain("event: response.milestone");
      expect(responseText).toContain('"result":"Checkpoint rejected"');
      expect(responseText).toContain('"evidence":"context_checkpoint_validation_failed"');

      // 2. The bridge emits response.failed with status 409 and the validation failure message
      expect(responseText).toContain("event: response.failed");
      expect(responseText).toContain('"status":"failed"');
      expect(responseText).toContain('"code":"context_checkpoint_validation_failed"');
      expect(responseText).toContain(validationErrorMessage);

      // 3. The stream terminates immediately with [DONE]
      expect(responseText).toContain("data: [DONE]");

      // 4. CRITICAL: The stream NEVER emitted a "compaction" item and NEVER emitted "response.completed"
      // This is why Codex CLI's stream reader (which expects a compaction item) fails with:
      // "Error running remote compact task: stream disconnected before completion: <error message>"
      expect(responseText).not.toContain('"type":"compaction"');
      expect(responseText).not.toContain("event: response.completed");
    });

    it("verifies that a successful compaction stream emits exactly one compaction item followed by response.completed", async () => {
      async function* successfulCompactionStream(): AsyncGenerator<AdapterEvent> {
        yield { type: "heartbeat" };
        yield {
          type: "milestone",
          kind: "checkpoint_completed",
          result: "Checkpoint validated",
          evidence: "structured_state_and_source_invariants",
          nextStep: "Run catalog build script",
        };
        yield {
          type: "text_delta",
          text: "<compaction_state>\nversion: 2\nactive_hypothesis: test\n</compaction_state>",
          phase: "final_answer",
        };
        yield { type: "done", endTurn: true };
      }

      const stream = bridgeToResponsesSSE(
        successfulCompactionStream(),
        "chatgpt-web/high",
        undefined,
        undefined,
        undefined,
        undefined,
        10_000,
        { compaction: true },
      );

      const responseText = await new Response(stream).text();

      // In the successful path, exactly one compaction item is emitted before completed
      expect(responseText).toContain('"type":"compaction"');
      expect(responseText).toContain('"encrypted_content":"ocx1:');
      expect(responseText).toContain("event: response.completed");
      expect(responseText).toContain("data: [DONE]");
      expect(responseText).not.toContain("event: response.failed");
    });

    it("simulates full HTTP /v1/responses SSE request and captures exact Codex error contract", async () => {
      const { responseRequest } = await import("../src/server/response-route");
      const { defaultConfig } = await import("../src/config");

      const config = defaultConfig("browser-only");
      const request = new Request("http://127.0.0.1:17841/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "chatgpt-web/high",
          stream: true,
          input: [
            { type: "message", role: "user", content: "Fix catalog" },
            { type: "compaction_trigger" },
          ],
        }),
      });

      const response = await responseRequest(request, config, () => ({
        name: "test-failing-compaction-adapter",
        async runTurn(_parsed, _incoming, emit) {
          emit({
            type: "milestone",
            kind: "intervention_required",
            result: "Checkpoint rejected",
            evidence: "context_checkpoint_validation_failed",
            nextStep: "Review the checkpoint and retry compaction explicitly",
          });
          emit({
            type: "error",
            message: "Context checkpoint failed validation: Missing active objective or hypothesis",
            status: 409,
            errorType: "invalid_response_error",
            code: "context_checkpoint_validation_failed",
            retryable: false,
          });
        },
      }));

      expect(response.status).toBe(200); // SSE streams return HTTP 200 headers
      expect(response.headers.get("content-type")).toBe("text/event-stream");

      const sseBody = await response.text();
      // The SSE stream delivers the failure frame and finishes with [DONE]
      expect(sseBody).toContain("event: response.failed");
      expect(sseBody).toContain('"status":"failed"');
      expect(sseBody).toContain("Context checkpoint failed validation: Missing active objective or hypothesis");
      expect(sseBody).toContain("data: [DONE]");
      expect(sseBody).not.toContain("event: response.completed");
      expect(sseBody).not.toContain('"type":"compaction"');
    });
  });

  describe("Deterministic Auto-Healing and Invariant Injection in Canonicalization", () => {
    it("canonicalizeCompactionHandoff auto-injects missing modified_files detected from apply_patch", () => {
      const parsedReq: CodexParsedRequest = {
        modelId: "chatgpt-web/high",
        stream: true,
        context: {
          messages: samplePatchedMessages,
        },
        options: { reasoning: "high" },
        _compactionRequest: true,
        _rawBody: {
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Actualizar catalogo y scripts de importacion" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_source_cat" },
          }],
        },
      };

      // Model generated a checkpoint with empty modified_files or missing them
      const summaryWithoutFiles = [
        "Catalog setup summary.",
        "<compaction_state>",
        "version: 2",
        "original_request_ref: Actualizar catalogo",
        "modified_files:",
        "- None",
        "active_hypothesis: Complete catalog import scripts and verify generated outputs.",
        "requirements:",
        '- {"id":"REQ-1","status":"pending","source":"Actualizar catalogo"}',
        "closure_criteria:",
        "- All catalog scripts run without errors",
        "verified_achievements:",
        "decisions_and_invariants:",
        "- Keep sample files under .agents/scratch/",
        "blockers_or_test_failures:",
        "- None",
        "pending_obligations:",
        "- Run catalog build script",
        "next_actions:",
        "- Run catalog build script",
        "</compaction_state>",
      ].join("\n");

      const canonicalized = canonicalizeCompactionHandoff(parsedReq, summaryWithoutFiles);

      // It must auto-inject the 5 files detected from apply_patch tool results!
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs");
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/.agents/scratch/build_pillaca_catalog.py");
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/docs/catalog/TALLER_PILLACA.md");
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-premium-sample.py");
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-rembg-sample.py");

      // And it must now PASS validateCompactionQuality!
      const verdict = validateCompactionQuality(samplePatchedMessages, canonicalized, {
        requireStructured: true,
      });
      expect(verdict.valid).toBe(true);
      expect(verdict.missingInvariants).toHaveLength(0);
    });

    it("canonicalizeCompactionHandoff auto-heals an empty/malformed <compaction_state> block into a valid v2 checkpoint", () => {
      const parsedReq: CodexParsedRequest = {
        modelId: "chatgpt-web/high",
        stream: true,
        context: {
          messages: samplePatchedMessages,
        },
        options: { reasoning: "high" },
        _compactionRequest: true,
        _rawBody: {
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Actualizar catalogo y scripts de importacion" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_source_cat" },
          }],
        },
      };

      // Model returned only empty tags or bare narrative
      const emptyBlockDraft = [
        "Here is the summary of work so far.",
        "<compaction_state>",
        "</compaction_state>",
      ].join("\n");

      const canonicalized = canonicalizeCompactionHandoff(parsedReq, emptyBlockDraft);

      // Must be healed to a valid v2 state block
      expect(canonicalized).toContain("<compaction_state>");
      expect(canonicalized).toContain("version: 2");
      expect(canonicalized).toContain("modified_files:");
      expect(canonicalized).toContain("- /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs");
      expect(canonicalized).toContain("active_hypothesis:");
      expect(canonicalized).toContain("requirements:");
      expect(canonicalized).toContain("closure_criteria:");
      expect(canonicalized).toContain("next_actions:");
      expect(canonicalized).toContain("</compaction_state>");

      // And it MUST PASS validation so the stream doesn't fail!
      const verdict = validateCompactionQuality(samplePatchedMessages, canonicalized, {
        requireStructured: true,
      });
      expect(verdict.valid).toBe(true);
      expect(verdict.missingInvariants).toHaveLength(0);
    });

    it("canonicalizeCompactionHandoff deduplicates entries and normalizes duplicate requirement IDs from model hallucinations", () => {
      const parsedReq: CodexParsedRequest = {
        modelId: "chatgpt-web/high",
        stream: true,
        context: {
          messages: samplePatchedMessages,
        },
        options: { reasoning: "high" },
        _compactionRequest: true,
        _rawBody: {
          input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Actualizar catalogo y scripts de importacion" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_source_cat" },
          }],
        },
      };

      // Model hallucinated duplicate requirements with the same ID, and duplicate blockers/invariants
      const hallucinatedSummary = [
        "Work in progress.",
        "<compaction_state>",
        "version: 2",
        "original_request_ref: Actualizar catalogo",
        "modified_files:",
        "- /home/deuz/projects/Allpa Craft/scripts/import-catalog-csv.mjs",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/build_pillaca_catalog.py",
        "- /home/deuz/projects/Allpa Craft/docs/catalog/TALLER_PILLACA.md",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-premium-sample.py",
        "- /home/deuz/projects/Allpa Craft/.agents/scratch/pillaca-rembg-sample.py",
        "active_hypothesis: Complete catalog import scripts and verify generated outputs.",
        "requirements:",
        '- {"id":"REQ-1","status":"pending","source":"Actualizar catalogo"}',
        '- {"id":"REQ-1","status":"pending","source":"Actualizar catalogo parte 2"}',
        "closure_criteria:",
        "- All catalog scripts run without errors",
        "- All catalog scripts run without errors",
        "verified_achievements:",
        "decisions_and_invariants:",
        "- Keep sample files under .agents/scratch/",
        "- Keep sample files under .agents/scratch/",
        "blockers_or_test_failures:",
        "- None",
        "- None",
        "pending_obligations:",
        "- Run catalog build script",
        "- Run catalog build script",
        "next_actions:",
        "- Run catalog build script",
        "</compaction_state>",
      ].join("\n");

      const canonicalized = canonicalizeCompactionHandoff(parsedReq, hallucinatedSummary);

      // Verify that requirement IDs are unique and sections are deduplicated
      expect(canonicalized).toContain('{"id":"REQ-1","status":"pending"');
      expect(canonicalized).toContain('{"id":"REQ-1-2","status":"pending"');

      // And it must pass validateCompactionQuality without duplicate invariant errors!
      const verdict = validateCompactionQuality(samplePatchedMessages, canonicalized, {
        requireStructured: true,
      });
      expect(verdict.valid).toBe(true);
      expect(verdict.missingInvariants).toHaveLength(0);
    });
  });
});


