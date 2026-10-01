import { CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT } from "../../../chatgpt-web-models";
import type { CompiledBrowserPayloadMetrics } from "../input-tokens";
import type { ChatGptSkillFile } from "../skill-attachments";

export interface ChatGptWebPromptImage {
  ref: string;
  imageUrl: string;
  detail?: string;
}

export interface PromptCompilationResult {
  version: 1;
  transport?: MultipartTransportManifest;
  sourceSha256: string;
  payloadSha256: string;
  measurement: CompiledBrowserPayloadMetrics;
  sections: {
    stableInstructionsSha256: string;
    capabilitiesSha256: string;
    taskContextSha256: string;
    toolHistorySha256: string;
  };
  transformations: string[];
}

export interface CompiledChatGptWebPrompt {
  compilation?: PromptCompilationResult;
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
  phaseCheckpointInstruction?: string;
  experimentalSkillAttachments?: boolean;
  experimentalMultipartParts?: ChatGptWebMultipartPartCount;
  /**
   * Manual Zero Risk transport keeps ChatGPT model/effort selection and prompt submission under the
   * user's control. The browser bridge may open the owned tab and copy this prompt, but it never
   * reads or mutates ChatGPT's DOM. Completion is accepted only through the bound Zero Risk MCP tools.
   */
  manualControl?: true;
  continuation?: boolean;
  /**
   * Enterprise conversational freedom: when true (default), eliminates artificial brevity throttles.
   */
  conversationalFreedom?: boolean;
  /**
   * Optional default verbosity override ("unconstrained" | "high" | "medium" | "low").
   */
  defaultVerbosity?: "unconstrained" | "high" | "medium" | "low";
}

export const CHATGPT_BIGGER_CONTEXT_PARTS = 6 as const;
export type ChatGptWebMultipartPartCount = 2 | typeof CHATGPT_BIGGER_CONTEXT_PARTS;
export type ChatGptWebMultipartParts = readonly string[];

export interface MultipartTransportManifest {
  encodingVersion: 2;
  encoding: typeof RECORD_FRAGMENT_ENCODING;
  requiredHelperCapabilities: readonly string[];
}

export interface ChatGptWebMultipartPrompt {
  transport?: MultipartTransportManifest;
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

/** Internal host/helper wire encoding; unrelated to the public MCP/checkpoint version. */
export const RECORD_FRAGMENT_CAPABILITY = "continuity-record-fragments-v1";
export const RECORD_FRAGMENT_ENCODING = "record-fragments-v1";

export interface MultipartRecordFragment {
  kind: "record_fragment";
  record_index: number;
  record_sha256: string;
  record_length: number;
  offset: number;
  length: number;
  sha256: string;
  data_base64: string;
}

export type MultipartTransportRecord = MultipartContextRecord | MultipartRecordFragment;

export interface MultipartRecordWeight {
  tokens: number;
  chars: number;
}
