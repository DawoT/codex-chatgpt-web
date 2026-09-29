import { expect, test } from "bun:test";
import {
  ChatGptMarkdownBuffer,
  chatGptHtmlToMarkdown,
  inspectCompactionResponseSurface,
} from "../src/adapters/chatgpt-web/markdown";
import { parseCompactionState } from "../src/responses/compaction";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown)).toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe(
    [
      "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
      "",
      "```",
      "src/example.ts",
      "```",
    ].join("\n"),
  );
});

test("does not nest a generated file link inside an existing link", () => {
  expect(
    chatGptHtmlToMarkdown('<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>'),
  ).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>```not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe(
    [
      "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
      "",
      "Keep `[[wiki/example]]` and ![[image.png]] literal.",
      "",
      "````",
      "```not a closing fence",
      "[[wiki/fenced]]",
      "````",
    ].join("\n"),
  );
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(
    chatGptHtmlToMarkdown(
      [
        "<p>&lt;proposed_plan&gt;</p>",
        "<h2>Plan</h2>",
        "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
      ].join(""),
    ),
  ).toBe(["<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>"].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>")).toBe(
    "<proposed_plan>  \nStep  \n</proposed_plan>",
  );
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(
    chatGptHtmlToMarkdown(
      [
        "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
        "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
        "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
      ].join(""),
    ),
  ).toBe(
    [
      "Mention <proposed\\_plan> and </proposed\\_plan> inline.",
      "",
      "`<proposed_plan>` `</proposed_plan>`",
      "",
      "```",
      "<proposed\\_plan>",
      "</proposed\\_plan>",
      "```",
    ].join("\n"),
  );
});

test("preserves a compaction checklist rendered as ordinary paragraphs", () => {
  const markdown = chatGptHtmlToMarkdown(
    [
      "<p>&lt;compaction_state&gt;</p>",
      "<p>version: 2</p>",
      "<p>original_request_ref: user turn 1</p>",
      "<p>modified_files:</p>",
      "<p>active_hypothesis: Finish the task.</p>",
      "<p>requirements:</p>",
      '<ul><li>{"id":"REQ-1","status":"pending","source":"user turn 1"}</li></ul>',
      "<p>closure_criteria:</p>",
      "<p>verified_achievements:</p>",
      "<p>decisions_and_invariants:</p>",
      "<p>blockers_or_test_failures:</p>",
      "<p>pending_obligations:</p>",
      "<p>next_actions:</p>",
      "<ul><li>Finish the task.</li></ul>",
      "<p>&lt;/compaction_state&gt;</p>",
    ].join(""),
  );

  expect(markdown).toContain("<compaction_state>\n");
  expect(markdown).toContain("original_request_ref: user turn 1");
  expect(markdown).toContain("modified_files:");
  expect(markdown).toContain("blockers_or_test_failures:");
  expect(markdown).toContain("</compaction_state>");
});

test("checkpoint surface diagnostics distinguish a renderer boundary from Markdown loss without content", () => {
  const diagnostic = inspectCompactionResponseSurface(
    {
      visibleText: "<compaction_state>\nversion: 2\n</compaction_state>",
      fullHtml: "<p>&lt;compaction_state&gt;</p><p>version: 2</p><p>&lt;/compaction_state&gt;</p>",
    },
    "version: 2\n</compaction_state>",
  );

  expect(diagnostic).toEqual({
    visibleOpeningTags: 1,
    visibleClosingTags: 1,
    htmlOpeningTags: 1,
    htmlClosingTags: 1,
    markdownOpeningTags: 0,
    markdownClosingTags: 1,
  });
});

test("does not reinterpret escaped compaction syntax inside a fenced example", () => {
  const markdown = chatGptHtmlToMarkdown(
    [
      "<pre><code>&lt;compaction\\_state&gt;\n",
      "original\\_request\\_ref: example\n",
      "&lt;/compaction\\_state&gt;</code></pre>",
      "<p>ordinary_field: remains ordinary.</p>",
    ].join(""),
  );

  expect(markdown).toContain("<compaction\\_state>\noriginal\\_request\\_ref: example\n</compaction\\_state>");
  expect(markdown).toContain("ordinary\\_field: remains ordinary.");
});

test("a segmented browser response retains parseable compaction fields", () => {
  const blocks = [
    "&lt;compaction_state&gt;",
    "version: 2",
    "original_request_ref: user turn 1",
    "modified_files:",
    "active_hypothesis: Finish the task.",
    "requirements:",
    "closure_criteria:",
    "verified_achievements:",
    "decisions_and_invariants:",
    "blockers_or_test_failures:",
    "pending_obligations:",
    "next_actions:",
    "&lt;/compaction_state&gt;",
  ];
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(
    blocks.map((block, index) => ({
      key: `block-${index}`,
      tag: "p",
      html: `<p>${block}</p>`,
      text: block,
      streamable: index < blocks.length - 1,
    })),
    0,
  );

  const state = parseCompactionState(buffer.finish().markdown);
  expect(state?.version).toBe(2);
  expect(state?.originalRequestRef).toBe("user turn 1");
  expect(state?.activeHypothesis).toBe("Finish the task.");
});

test("preserves an actual compaction_state DOM element rather than dropping its boundary", () => {
  const markdown = chatGptHtmlToMarkdown(
    "<compaction_state><p>version: 2</p><p>original_request_ref: user turn 1</p></compaction_state>",
  );

  expect(markdown).toContain("<compaction_state>");
  expect(markdown).toContain("original_request_ref: user turn 1");
  expect(markdown).toContain("</compaction_state>");
});

test("a rendered requirement keeps JSON evidence with Markdown punctuation parseable", () => {
  const markdown = chatGptHtmlToMarkdown(
    [
      "<p>&lt;compaction_state&gt;</p>",
      "<p>version: 2</p>",
      "<p>requirements:</p>",
      '<ul><li>{"id":"REQ-1","status":"verified","source":"user: foo_bar [x] *","evidence":"bun test: 1 pass"}</li></ul>',
      "<p>&lt;/compaction_state&gt;</p>",
    ].join(""),
  );

  expect(parseCompactionState(markdown)?.requirements).toEqual([
    {
      id: "REQ-1",
      status: "verified",
      source: "user: foo_bar [x] *",
      evidence: "bun test: 1 pass",
    },
  ]);
});

test("a rendered requirement preserves literal Windows path backslashes", () => {
  const source = String.raw`user: inspect C:\temp\foo_bar.ts`;
  const requirement = JSON.stringify({ id: "REQ-1", status: "pending", source });
  const markdown = chatGptHtmlToMarkdown(
    [
      "<p>&lt;compaction_state&gt;</p>",
      "<p>requirements:</p>",
      `<ul><li>${requirement}</li></ul>`,
      "<p>&lt;/compaction_state&gt;</p>",
    ].join(""),
  );

  expect(parseCompactionState(markdown)?.requirements?.[0]?.source).toBe(source);
});

test("segmented checklist JSON preserves literal path and punctuation", () => {
  const source = String.raw`user: inspect C:\temp\foo_bar.ts [x] and pattern \*`;
  const requirement = JSON.stringify({ id: "REQ-1", status: "pending", source });
  const blocks = [
    "&lt;compaction_state&gt;",
    "version: 2",
    "requirements:",
    `<ul><li>${requirement}</li></ul>`,
    "&lt;/compaction_state&gt;",
  ];
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(
    blocks.map((block, index) => ({
      key: `path-block-${index}`,
      tag: "p",
      html: block.startsWith("<ul>") ? block : `<p>${block}</p>`,
      text: block,
      streamable: index < blocks.length - 1,
    })),
    0,
  );

  expect(parseCompactionState(buffer.finish().markdown)?.requirements?.[0]?.source).toBe(source);
});
