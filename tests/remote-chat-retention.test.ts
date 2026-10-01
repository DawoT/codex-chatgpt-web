import { expect, test } from "bun:test";
import { remoteChatRetentionDecision } from "../src/adapters/chatgpt-web/remote-chat-retention";

const healthy = {
  observedDomChars: 300_000,
  estimatedTokens: 10_000,
  compactionRequired: false,
  recoveryRequired: false,
};

test("only proven healthy remote context survives local compaction", () => {
  expect(remoteChatRetentionDecision(healthy, 12_000, 0)).toEqual({ retain: true, remoteContextTokens: 12_000 });
  expect(remoteChatRetentionDecision(undefined, 12_000, 0).retain).toBe(false);
  expect(remoteChatRetentionDecision({ ...healthy, observedDomChars: 650_000 }, 12_000, 0).retain).toBe(false);
  expect(remoteChatRetentionDecision({ ...healthy, recoveryRequired: true }, 12_000, 0).retain).toBe(false);
  expect(remoteChatRetentionDecision({ ...healthy, compactionRequired: true }, 12_000, 0).retain).toBe(false);
  expect(remoteChatRetentionDecision(healthy, 12_000, 40_000).retain).toBe(false);
  expect(remoteChatRetentionDecision({ ...healthy, estimatedTokens: NaN }, 12_000, 0).retain).toBe(false);
});
