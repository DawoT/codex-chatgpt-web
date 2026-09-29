import { CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT } from "../../../chatgpt-web-models";
import type { ChatGptSkillFile } from "../skill-attachments";

export interface ChatGptWebPromptImage {
  ref: string;
  imageUrl: string;
  detail?: string;
}

export interface CompiledChatGptWebPrompt {
  text: string;
  images: ChatGptWebPromptImage[];
  skillFiles?: ChatGptSkillFile[];
  /** Transactional transport when Bigger Context is explicitly enabled. */
  multipart?: ChatGptWebMultipartPrompt;
  /** Oldest history items removed by native-style compaction fit recovery; absent on normal turns. */
  trimmedCompactionMessages?: number;
}

export interface CompileChatGptWebPromptOptions {
  captureLunaCheckpoint?: boolean;
  experimentalSkillAttachments?: boolean;
  experimentalMultipartParts?: ChatGptWebMultipartPartCount;
  /**
   * Manual Zero Risk transport keeps ChatGPT model/effort selection and prompt submission under the
   * user's control. The browser bridge may open the owned tab and copy this prompt, but it never
   * reads or mutates ChatGPT's DOM. Completion is accepted only through the bound Zero Risk MCP tools.
   */
  manualControl?: true;
  continuation?: boolean;
}

export const CHATGPT_BIGGER_CONTEXT_PARTS = 6 as const;
export type ChatGptWebMultipartPartCount = 2 | typeof CHATGPT_BIGGER_CONTEXT_PARTS;
export type ChatGptWebMultipartParts = readonly string[];

export interface ChatGptWebMultipartPrompt {
  parts: ChatGptWebMultipartParts;
  commit: string;
}

export interface ChatGptWebMultipartStage {
  text: string;
  acknowledgement: string;
  sha256: string;
}

export const CHATGPT_MAX_INPUT_IMAGES = 10;
export const CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET = 110_000;

export const DEFAULT_RETAINED_COMPLETED_TOOL_RESULTS = 2;
export const HISTORICAL_TOOL_OUTPUT_PRUNE_THRESHOLD_CHARS = 250;
export const DEFAULT_MICRO_COMPACTION_TOKEN_CEILING = CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT;
export const DEFAULT_ROOT_PRUNING_TOKEN_CEILING = 12_000;

export interface PruneHistoricalToolOutputOptions {
  retainRecentCount?: number;
  maxHistoricalCharThreshold?: number;
}

export interface AdaptivePruningOptions {
  retainRecentToolResults?: number;
  maxHistoricalCharThreshold?: number;
  retainRecentSubagents?: number;
  maxPromptTokens?: number;
}

export interface ImageBudget {
  seen: number;
  dropped: number;
}

export type MultipartContextRecord =
  | { kind: "system"; system_index: number; content: string }
  | { kind: "message"; message_index: number; message: Record<string, unknown> };

export interface MultipartRecordWeight {
  tokens: number;
  chars: number;
}
