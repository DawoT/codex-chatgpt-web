import { createHash } from "node:crypto";
import { ChatGptBrowserWorker } from "../adapters/chatgpt-web/browser-worker";
import type { ChatGptWebCapabilities } from "../adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../adapters/chatgpt-web/turn-execution";
import type { CodexProviderConfig } from "../types";

let taskResumeNoteSequence = 0;

export function taskResumeCapabilities(provider: CodexProviderConfig): ChatGptWebCapabilities {
  return {
    localToolsEnabled: provider.chatgptWeb?.localToolsEnabled === true,
    solAvailable: provider.chatgptWeb?.solAvailable !== false,
    extraHighAvailable: provider.chatgptWeb?.extraHighAvailable === true,
    proAvailable: provider.chatgptWeb?.proAvailable === true,
  };
}

/**
 * Sprint H3: deliver ONE background-task resume note to a retained ChatGPT conversation.
 *
 * The note is observation-only: it replicates the requestRetainedCompactionHandoff turn shape
 * (compaction-handoff.ts) — a one-shot native-connector submission on the retained conversation
 * with the ordinary tool environment disabled — because only the CLI may start requests that
 * carry the full Codex history. The conversation head supplies the model identity the retained
 * conversation was created with; a retired head means the note can no longer be attributed
 * safely and fails without browser side effects.
 */
export async function runTaskResumeNote(
  provider: CodexProviderConfig,
  conversationKey: string,
  noteText: string,
  signal: AbortSignal,
): Promise<void> {
  const head = chatGptTurnSessions.findConversationHead(conversationKey);
  const source = head?.runtime.usageInput;
  if (!source) {
    throw new Error(`Background task resume note has no retained conversation head (${conversationKey.slice(0, 8)}…)`);
  }
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const prepare = async () => ({ text: noteText, images: [], release: () => {} });
  taskResumeNoteSequence += 1;
  const traceId = `task-resume-${createHash("sha256")
    .update(`${conversationKey}:${Date.now()}:${taskResumeNoteSequence}`)
    .digest("hex")
    .slice(0, 16)}`;
  await worker.run({
    traceId,
    modelId: source.modelId,
    reasoning: source.options.reasoning,
    ...(source._chatgptModelFamily ? { modelFamily: source._chatgptModelFamily } : {}),
    capabilities: { ...taskResumeCapabilities(provider), localToolsEnabled: false },
    nativeConnector: true,
    prepare,
    prepareResume: prepare,
    conversationKey,
    requireRetainedConversation: true,
    abortSignal: signal,
    onTextDelta: () => {},
  });
}
