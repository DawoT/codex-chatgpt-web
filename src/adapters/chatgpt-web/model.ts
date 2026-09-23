import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
} from "../../chatgpt-web-models";

export const CHATGPT_WEB_MODEL_ID = CHATGPT_WEB_BACKEND_MODEL;
export const CHATGPT_WEB_LUNA_MODEL_ID = CHATGPT_WEB_LUNA_BACKEND_MODEL;

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean;
  solAvailable: boolean;
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

export interface ChatGptWebModelMode {
  modelId: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  displayLabel: "Luna" | "Think" | "Instant" | "Medium" | "High" | "Extra High" | "Pro";
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null;
  thinkEnabled: boolean;
  localTools: boolean;
}

export interface AdaptiveReasoningContext {
  messages?: readonly { role: string; content: unknown }[];
  compactionRequest?: boolean;
  activeInputText?: string;
}

export function inferAdaptiveReasoningEffort(
  context?: AdaptiveReasoningContext,
  availableEfforts: Array<"low" | "medium" | "high" | "xhigh" | "max"> = ["low", "medium", "high"],
): "low" | "medium" | "high" {
  if (!context) return "high";
  if (context.compactionRequest) return "medium";

  const textToScan: string[] = [];
  if (context.activeInputText) textToScan.push(context.activeInputText);
  if (context.messages && context.messages.length > 0) {
    const recent = context.messages.slice(-3);
    for (const msg of recent) {
      if (typeof msg.content === "string") textToScan.push(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
            textToScan.push(String(part.text));
          }
        }
      }
    }
  }

  const combined = textToScan.join("\n");
  if (combined.length === 0) return "high";

  // Error patterns or deep complex tasks -> high effort
  const hasErrorPattern = /(?:AssertionError|TypeError|SyntaxError|ReferenceError|panic!|tests? failed|FAILED|npm ERR!|exit status 1|code 1\b|failed with result|FAIL\s+tests)/i.test(combined);
  const hasDeepRefactorPattern = /(?:refactor|architecture|redesign|race condition|deadlock|memory leak|concurrency)/i.test(combined);

  if (hasErrorPattern || hasDeepRefactorPattern) {
    return "high";
  }

  // Simple discovery or status inspection -> low effort if supported
  const isSimpleDiscovery = /^(?:list|ls|dir|status|what files|where is|pwd|show files)\b/i.test(combined.trim())
    || (combined.length < 80 && !/[?].*[?]/.test(combined) && !hasErrorPattern);

  if (isSimpleDiscovery && availableEfforts.includes("low")) {
    return "low";
  }

  return "medium";
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
  adaptiveContext?: AdaptiveReasoningContext,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    if (capabilities.solAvailable) {
      throw new Error("ChatGPT Luna is not available while the account exposes the Sol model selector");
    }
    const effort = reasoning ?? (adaptiveContext && inferAdaptiveReasoningEffort(adaptiveContext) === "low" ? "low" : "medium");
    if (effort !== "low" && effort !== "medium") {
      throw new Error(`ChatGPT Luna mode is not supported: ${effort}`);
    }
    const thinkEnabled = effort === "medium";
    return {
      modelId,
      effort,
      displayLabel: thinkEnabled ? "Think" : "Luna",
      uiEffortIndex: null,
      thinkEnabled,
      localTools: capabilities.localToolsEnabled,
    };
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`);
  }
  if (!capabilities.solAvailable) {
    throw new Error("ChatGPT Sol modes are not available for this Luna-only account");
  }
  const effort = reasoning ?? (adaptiveContext ? inferAdaptiveReasoningEffort(adaptiveContext) : "high");
  switch (effort) {
    case "low":
      return { modelId, effort, displayLabel: "Instant", uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "medium":
      return { modelId, effort, displayLabel: "Medium", uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "high":
      return { modelId, effort, displayLabel: "High", uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "xhigh":
      if (!capabilities.extraHighAvailable) throw new Error("ChatGPT Extra High effort is not available for this account");
      return { modelId, effort, displayLabel: "Extra High", uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    case "max":
      if (!capabilities.proAvailable) throw new Error("ChatGPT Pro effort is not available for this account");
      return { modelId, effort, displayLabel: "Pro", uiEffortIndex: 4, thinkEnabled: false, localTools: capabilities.localToolsEnabled };
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`);
  }
}
