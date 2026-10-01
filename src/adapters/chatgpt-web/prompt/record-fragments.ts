import { createHash } from "node:crypto";
import { estimateTokens } from "../../../lib/token-estimate";
import type {
  MultipartContextRecord,
  MultipartRecordFragment,
  MultipartRecordWeight,
  MultipartTransportManifest,
  MultipartTransportRecord,
} from "./types";
import { RECORD_FRAGMENT_CAPABILITY, RECORD_FRAGMENT_ENCODING } from "./types";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fragment only records that cannot fit whole in any available part. Never edit their bytes. */
export function fragmentMultipartRecords(
  records: readonly MultipartContextRecord[],
  budgets: readonly MultipartRecordWeight[],
): MultipartTransportRecord[] {
  const fragmentBudget = {
    chars: Math.min(...budgets.map((budget) => budget.chars)),
    tokens: Math.min(...budgets.map((budget) => budget.tokens)),
  };
  return records.flatMap((record, record_index): MultipartTransportRecord[] => {
    const serialized = JSON.stringify(record);
    const tokens = estimateTokens(serialized) + 1;
    if (budgets.some((budget) => serialized.length + 1 <= budget.chars && tokens <= budget.tokens)) return [record];
    const bytes = Buffer.from(serialized, "utf8");
    const record_sha256 = hash(bytes);
    const fragments: MultipartRecordFragment[] = [];
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = bytes.subarray(offset).toString("utf8");
      const makeFragment = (chars: number): MultipartRecordFragment => {
        // Preserve UTF-8 codepoints even when the binary search lands between UTF-16 surrogates.
        if (chars < remaining.length && /[\uD800-\uDBFF]/.test(remaining[chars - 1]!)) chars -= 1;
        const chunk = Buffer.from(remaining.slice(0, chars), "utf8");
        return {
          kind: "record_fragment",
          record_index,
          record_sha256,
          record_length: bytes.length,
          offset,
          length: chunk.length,
          sha256: hash(chunk),
          data_base64: chunk.toString("base64"),
        };
      };
      const physicalText = (fragment: MultipartRecordFragment): string =>
        JSON.stringify({
          ...fragment,
          data_base64: undefined,
          text: Buffer.from(fragment.data_base64, "base64").toString("utf8"),
        });
      // Find the exact JSON character boundary before tokenizing. Large sparse records should
      // need one tokenizer pass per fragment, not one pass per character-search iteration.
      let lower = 1;
      let upper = Math.min(remaining.length, fragmentBudget.chars);
      let charCandidate: MultipartRecordFragment | undefined;
      while (lower <= upper) {
        const chars = Math.floor((lower + upper) / 2);
        const fragment = makeFragment(chars);
        if (physicalText(fragment).length + 1 <= fragmentBudget.chars) {
          if (fragment.length > 0) charCandidate = fragment;
          lower = chars + 1;
        } else {
          upper = chars - 1;
        }
      }
      let selected: MultipartRecordFragment | undefined;
      if (charCandidate && estimateTokens(physicalText(charCandidate)) + 1 <= fragmentBudget.tokens) {
        selected = charCandidate;
      } else if (charCandidate) {
        lower = 1;
        upper = Buffer.from(charCandidate.data_base64, "base64").toString("utf8").length;
        while (lower <= upper) {
          const chars = Math.floor((lower + upper) / 2);
          const fragment = makeFragment(chars);
          const physical = physicalText(fragment);
          if (physical.length + 1 <= fragmentBudget.chars && estimateTokens(physical) + 1 <= fragmentBudget.tokens) {
            if (fragment.length > 0) selected = fragment;
            lower = chars + 1;
          } else {
            upper = chars - 1;
          }
        }
      }
      if (!selected) throw new RangeError("Record fragment metadata exceeds the available transport budget");
      fragments.push(selected);
      offset += selected.length;
    }
    return fragments;
  });
}

function fragmentBytes(fragment: MultipartRecordFragment): Buffer {
  if (
    typeof fragment.data_base64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fragment.data_base64)
  )
    throw new Error("Record fragment base64 is invalid");
  const bytes = Buffer.from(fragment.data_base64, "base64");
  const text = bytes.toString("utf8");
  if (
    !Number.isSafeInteger(fragment.record_index) ||
    fragment.record_index < 0 ||
    !Number.isSafeInteger(fragment.offset) ||
    fragment.offset < 0 ||
    !Number.isSafeInteger(fragment.length) ||
    fragment.length <= 0 ||
    !Number.isSafeInteger(fragment.record_length) ||
    fragment.record_length <= 0 ||
    fragment.length !== bytes.length ||
    fragment.offset + fragment.length > fragment.record_length ||
    fragment.sha256 !== hash(bytes) ||
    typeof fragment.record_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(fragment.record_sha256) ||
    bytes.toString("base64") !== fragment.data_base64 ||
    !Buffer.from(text, "utf8").equals(bytes)
  )
    throw new Error("Record fragment bytes, length or SHA-256 are invalid");
  return bytes;
}

function transportEnvelope(payload: string): {
  version: number;
  encoding?: string;
  part_index: number;
  total_parts: number;
  records: MultipartTransportRecord[];
} {
  const envelope = JSON.parse(payload);
  const hasFragments =
    Array.isArray(envelope.records) &&
    envelope.records.some((record: MultipartTransportRecord) => record.kind === "record_fragment");
  if (envelope.version === 2 || envelope.encoding !== undefined || hasFragments) {
    if (envelope.version !== 2 || envelope.encoding !== RECORD_FRAGMENT_ENCODING || !Array.isArray(envelope.records)) {
      throw new Error("Unsupported multipart fragment encoding");
    }
  }
  return envelope;
}

/** Reassemble and verify whole serialized records on the host before any part is submitted. */
export function reconstructMultipartRecords(parts: readonly string[]): MultipartContextRecord[] {
  const envelopes = parts.map(transportEnvelope);
  const fragmented = envelopes.some((envelope) => envelope.version === 2);
  const records: MultipartContextRecord[] = [];
  let pending: { first: MultipartRecordFragment; chunks: Buffer[]; offset: number } | undefined;
  for (const [index, envelope] of envelopes.entries()) {
    if (
      fragmented &&
      (envelope.version !== 2 || envelope.part_index !== index + 1 || envelope.total_parts !== parts.length)
    ) {
      throw new Error("Multipart fragment part order or count is invalid");
    }
    for (const record of envelope.records ?? []) {
      if (record.kind !== "record_fragment") {
        if (pending) throw new Error("Record fragment sequence was interrupted");
        records.push(record);
        continue;
      }
      const bytes = fragmentBytes(record);
      if (!pending) pending = { first: record, chunks: [], offset: 0 };
      if (
        record.record_index !== records.length ||
        record.offset !== pending.offset ||
        record.record_sha256 !== pending.first.record_sha256 ||
        record.record_length !== pending.first.record_length
      )
        throw new Error("Record fragment order, offset or identity is invalid");
      pending.chunks.push(bytes);
      pending.offset += bytes.length;
      if (pending.offset === record.record_length) {
        const original = Buffer.concat(pending.chunks);
        if (hash(original) !== record.record_sha256)
          throw new Error("Reconstructed record fragment SHA-256 is invalid");
        let decoded: MultipartContextRecord;
        try {
          decoded = JSON.parse(original.toString("utf8"));
        } catch {
          throw new Error("Reconstructed record fragment JSON is invalid");
        }
        if (decoded.kind !== "system" && decoded.kind !== "message")
          throw new Error("Reconstructed record fragment kind is invalid");
        records.push(decoded);
        pending = undefined;
      }
    }
  }
  if (pending) throw new Error("Record fragment sequence is incomplete");
  return records;
}

/** Decode internal base64 on the host; ChatGPT receives literal serialized record text. */
export function decodeMultipartTransportPart(payload: string): string {
  const envelope = transportEnvelope(payload);
  if (envelope.version !== 2) return payload;
  return JSON.stringify({
    ...envelope,
    records: envelope.records.map((record) => {
      if (record.kind !== "record_fragment") return record;
      const { data_base64, ...metadata } = record;
      return { ...metadata, text: fragmentBytes(record).toString("utf8") };
    }),
  });
}

/** Advertise the internal wire requirement independently of public tool/checkpoint contracts. */
export function multipartTransportManifest(parts: readonly string[]): MultipartTransportManifest | undefined {
  reconstructMultipartRecords(parts);
  if (!parts.some((part) => transportEnvelope(part).version === 2)) return undefined;
  return {
    encodingVersion: 2,
    encoding: RECORD_FRAGMENT_ENCODING,
    requiredHelperCapabilities: [RECORD_FRAGMENT_CAPABILITY],
  };
}
