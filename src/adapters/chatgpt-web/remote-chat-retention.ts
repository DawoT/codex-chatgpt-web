import {
  CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT,
  CHATGPT_TOKEN_SATURATION_CEILING,
} from "./browser/context-pressure";
import type { ChatGptContextHealth } from "./helper-protocol";

export function remoteChatRetentionDecision(
  health: ChatGptContextHealth | undefined,
  canonicalTokens: number,
  priorRemoteTokens: number,
): { retain: boolean; remoteContextTokens: number } {
  // Native compact lowers local history only. Carry a conservative remote high-water estimate.
  const remoteContextTokens = Math.max(health?.estimatedTokens ?? 0, priorRemoteTokens + canonicalTokens);
  const retain = Boolean(
    health &&
      Number.isFinite(health.observedDomChars) &&
      health.observedDomChars > 0 &&
      Number.isFinite(remoteContextTokens) &&
      remoteContextTokens > 0 &&
      health.observedDomChars < CHATGPT_BROWSER_DOM_COMPACTION_CHAR_LIMIT &&
      remoteContextTokens < CHATGPT_TOKEN_SATURATION_CEILING * 0.85 &&
      !health.compactionRequired &&
      !health.recoveryRequired,
  );
  return { retain, remoteContextTokens };
}
