import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  partitionMultipartContext,
} from "../src/adapters/chatgpt-web/prompt/multipart";
import type { MultipartContextRecord } from "../src/adapters/chatgpt-web/prompt/types";

// Catches an indivisible record remaining oversized, or any byte/role/id/order loss.
test("an oversized serialized record travels as reversible byte-addressed fragments", () => {
  const record: MultipartContextRecord = {
    kind: "message",
    message_index: 7,
    message: {
      role: "tool_result",
      tool_call_id: "call_á-🐙",
      content: `先頭\n${"x".repeat(104_767)}\u0000"\\é🐙終`,
    },
  };
  const original = Buffer.from(JSON.stringify(record), "utf8");
  const parts = partitionMultipartContext(
    [record],
    6,
    Array.from({ length: 6 }, () => ({ chars: 25_000, tokens: 20_000 })),
  );
  const envelopes = parts.map((part) => JSON.parse(part));
  expect(envelopes.every((part) => part.version === 2)).toBe(true);
  const fragments = envelopes.flatMap((part) => part.records);
  expect(fragments.length).toBeGreaterThan(1);
  let offset = 0;
  const bytes = fragments.map((fragment) => {
    expect(fragment.kind).toBe("record_fragment");
    expect(fragment.record_index).toBe(0);
    expect(fragment.offset).toBe(offset);
    const chunk = Buffer.from(fragment.data_base64, "base64");
    expect(fragment.length).toBe(chunk.length);
    expect(fragment.record_length).toBe(original.length);
    expect(fragment.record_sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(fragment.sha256).toBe(createHash("sha256").update(chunk).digest("hex"));
    offset += chunk.length;
    return chunk;
  });
  expect(Buffer.concat(bytes).equals(original)).toBe(true);
  expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(record);
});

// Catches base64 leaking to the model instead of host-decoded exact serialized text.
test("the host decodes fragment bytes into readable transport JSON before Send", () => {
  const record: MultipartContextRecord = {
    kind: "system",
    system_index: 0,
    content: '🙂漢字é\n"\\'.repeat(700),
  };
  const parts = partitionMultipartContext(
    [record],
    6,
    Array.from({ length: 6 }, () => ({ chars: 4_000, tokens: 3_000 })),
  );
  const transaction = `ctx_${"a".repeat(32)}`;
  const messages = [
    ...parts.slice(0, -1).map((part, index) => formatChatGptWebMultipartStage(part, transaction, index + 1, 6).text),
    formatChatGptWebMultipartCommit({ parts, commit: "Execute." }, transaction),
  ];
  const physical = messages.flatMap((message) => JSON.parse(message.split("```json\n")[1]!.split("\n```")[0]!).records);
  expect(physical.every((fragment) => typeof fragment.text === "string")).toBe(true);
  expect(messages.every((message) => !message.includes("data_base64"))).toBe(true);
  expect(physical.map((fragment) => fragment.text).join("")).toBe(JSON.stringify(record));
  expect(messages.at(-1)).toContain("UTF-8 byte offset");
});

// Catches accepting corrupted, missing, duplicated or reordered bytes before browser submission.
test("the host refuses damaged or discontinuous record fragments before formatting a commit", () => {
  const records: MultipartContextRecord[] = [
    { kind: "system", system_index: 0, content: "before" },
    { kind: "message", message_index: 0, message: { role: "developer", content: "🐙".repeat(3_000) } },
    {
      kind: "message",
      message_index: 1,
      message: { role: "assistant", content: "after", tool_calls: [{ id: "call_1" }] },
    },
  ];
  const parts = partitionMultipartContext(
    records,
    6,
    Array.from({ length: 6 }, () => ({ chars: 4_000, tokens: 3_000 })),
  );
  const transaction = `ctx_${"b".repeat(32)}`;
  const envelopes = parts.map((part) => JSON.parse(part));
  const first = envelopes.findIndex((part) =>
    part.records.some((record: { kind: string }) => record.kind === "record_fragment"),
  );
  for (const change of [
    (fragment: any) => {
      fragment.offset += 1;
    },
    (fragment: any) => {
      fragment.length += 1;
    },
    (fragment: any) => {
      fragment.record_length += 1;
    },
    (fragment: any) => {
      fragment.sha256 = "0".repeat(64);
    },
    (fragment: any) => {
      fragment.record_sha256 = "0".repeat(64);
    },
    (fragment: any) => {
      fragment.data_base64 = "!!!!";
    },
    (fragment: any) => {
      fragment.data_base64 = Buffer.from([0xff]).toString("base64");
      fragment.length = 1;
      fragment.sha256 = createHash("sha256")
        .update(Buffer.from([0xff]))
        .digest("hex");
    },
  ]) {
    const damaged = structuredClone(envelopes);
    change(damaged[first]!.records.find((record: { kind: string }) => record.kind === "record_fragment"));
    expect(() =>
      formatChatGptWebMultipartCommit(
        { parts: damaged.map((part) => JSON.stringify(part)), commit: "Execute." },
        transaction,
      ),
    ).toThrow(/fragment/i);
  }
  for (const mutation of [
    (parts: any[]) => {
      const locations = parts
        .flatMap((part, partIndex) =>
          part.records.map((record: any, recordIndex: number) => ({ record, partIndex, recordIndex })),
        )
        .filter((location) => location.record.kind === "record_fragment");
      const [a, b] = locations;
      parts[a.partIndex].records[a.recordIndex] = b.record;
      parts[b.partIndex].records[b.recordIndex] = a.record;
    },
    (parts: any[]) => {
      parts[first]!.records.pop();
    },
    (parts: any[]) => {
      parts[first]!.records.push(parts[first]!.records[0]);
    },
    (parts: any[]) => {
      parts[first]!.encoding = "unknown";
    },
    (parts: any[]) => {
      parts[first]!.version = 1;
    },
    (parts: any[]) => {
      parts[first]!.part_index += 1;
    },
  ]) {
    const damaged = structuredClone(envelopes);
    mutation(damaged);
    expect(() =>
      formatChatGptWebMultipartCommit(
        { parts: damaged.map((part) => JSON.stringify(part)), commit: "Execute." },
        transaction,
      ),
    ).toThrow(/fragment/i);
  }
});
