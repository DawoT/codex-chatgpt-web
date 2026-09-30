import { describe, expect, test } from "bun:test";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

describe("Sprint U: Adaptive Markdown Streaming Latency & Instant Tool Emission", () => {
  const makeSegment = (key: string, text: string, streamable = true, tag = "P"): ChatGptMarkdownSegment => ({
    key,
    tag,
    text,
    html: tag === "PRE" ? `<pre><code>${text}</code></pre>` : `<p>${text}</p>`,
    streamable,
  });

  test("maintains backward compatibility with numeric stability window", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, 200);
    const seg1 = makeSegment("k1", "Hello world");
    const t0 = 1000;

    // Initial observation (0ms elapsed): not yet stable
    const d0 = buffer.observe([seg1], t0);
    expect(d0).toBe("");

    // 150ms elapsed: still not stable (200ms required)
    const d1 = buffer.observe([seg1], t0 + 150);
    expect(d1).toBe("");

    // 250ms elapsed: stable -> emitted
    const d2 = buffer.observe([seg1], t0 + 250);
    expect(d2).toContain("Hello world");
  });

  test("emits tool and code segments instantly (0ms latency) in adaptive mode", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, {
      adaptive: true,
      proseStabilityMs: 350,
      toolStabilityMs: 0,
    });
    const toolSeg = makeSegment("tool-1", '```json\n{"tool": "codex_read_file"}\n```', true, "PRE");
    const t0 = 1000;

    // Instantly emitted with 0ms elapsed time!
    const delta = buffer.observe([toolSeg], t0);
    expect(delta).toContain("codex_read_file");
  });

  test("applies 350ms stability window to prose paragraphs in adaptive mode", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, {
      adaptive: true,
      proseStabilityMs: 350,
      toolStabilityMs: 0,
    });
    const proseSeg = makeSegment("prose-1", "This is an explanatory paragraph.", true, "P");
    const t0 = 1000;

    // At t0: not yet stable
    expect(buffer.observe([proseSeg], t0)).toBe("");

    // At t0 + 200ms: still waiting
    expect(buffer.observe([proseSeg], t0 + 200)).toBe("");

    // At t0 + 360ms: stable and committed!
    const delta = buffer.observe([proseSeg], t0 + 360);
    expect(delta).toContain("This is an explanatory paragraph.");
  });

  test("emits mixed stream: tools immediately and prose after stability", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, {
      adaptive: true,
      proseStabilityMs: 300,
      toolStabilityMs: 0,
    });
    const toolSeg = makeSegment("s-tool", "```\ncodex_exec ls\n```", true, "PRE");
    const proseSeg = makeSegment("s-prose", "Here are the files:", true, "P");
    const t0 = 1000;

    // At t0: tool is emitted immediately, prose waits for stability
    const d0 = buffer.observe([toolSeg, proseSeg], t0);
    expect(d0).toContain("codex_exec ls");
    expect(d0).not.toContain("Here are the files:");

    // At t0 + 150: prose still waiting
    expect(buffer.observe([toolSeg, proseSeg], t0 + 150)).toBe("");

    // At t0 + 310: prose has stabilized and emits
    expect(buffer.observe([toolSeg, proseSeg], t0 + 310)).toContain("Here are the files:");
  });

  test("harmless empty spacer elements across multi-tool turn do not trigger block_order_changed conflict", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, 0);
    const emptySeg1 = makeSegment("k-empty-1", "", true, "P");
    const proseSeg1 = makeSegment("k-prose-1", "First answer block", true, "P");
    const toolSeg1 = makeSegment("k-tool-1", '```json\n{"call": 1}\n```', true, "PRE");

    // First observation: empty spacer + prose + tool
    buffer.observe([emptySeg1, proseSeg1, toolSeg1], 1000);

    // Later DOM update: ChatGPT moves or adds another empty spacer
    const emptySeg2 = makeSegment("k-empty-2", "", true, "P");
    const proseSeg2 = makeSegment("k-prose-2", "Second answer block", true, "P");

    // Reconciling with new empty spacer should not throw block_order_changed
    expect(() => {
      buffer.observe([proseSeg1, toolSeg1, emptySeg2, proseSeg2], 2000);
      buffer.finish();
    }).not.toThrow();
  });

  test("repeated short phrases without source ranges across tool calls do not trigger block_order_changed conflict", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, 0);
    // 13-character phrase emitted after tool 1
    const p1 = makeSegment("0:p", "File updated.", true, "p");
    const toolCall = makeSegment("1:pre", '```json\n{"call": "exec"}\n```', true, "pre");
    buffer.observe([p1, toolCall], 1000);

    // After tool 2, ChatGPT repeats the same 13-character phrase as a new paragraph
    const p2Pending = makeSegment("2:p", "Running tests...", true, "p");
    const p3Duplicate = makeSegment("3:p", "File updated.", true, "p");

    expect(() => {
      buffer.observe([p1, toolCall, p2Pending, p3Duplicate], 2000);
      const res = buffer.finish();
      expect(res.markdown).toContain("File updated.");
      expect(res.markdown).toContain("Running tests...");
    }).not.toThrow();
  });

  test("forceFinish commits remaining segments and recovers cleanly when consistency conflict was set", () => {
    const buffer = new ChatGptMarkdownBuffer((m) => m, 0);
    const seg1 = makeSegment("k1", "Initial response", true, "p");
    buffer.observe([seg1], 1000);

    // Intentionally create a rewrite conflict on key k1 with sourceStart
    const seg1Changed = { ...seg1, text: "Rewritten response", sourceStart: 0, sourceEnd: 15 };
    const seg1Committed = { ...seg1, sourceStart: 0, sourceEnd: 16 };
    // Observe normal ranged segment
    const b2 = new ChatGptMarkdownBuffer((m) => m, 0);
    b2.observe([seg1Committed], 1000);
    b2.observe([seg1Changed], 2000);
    expect(b2.currentSnapshotIsConsistent()).toBe(false);

    // finish() would throw:
    expect(() => b2.finish()).toThrow();

    // forceFinish() completes cleanly without throwing:
    const forced = b2.forceFinish();
    expect(forced).toBeDefined();
    expect(b2.currentSnapshotIsConsistent()).toBe(true);
  });
});
