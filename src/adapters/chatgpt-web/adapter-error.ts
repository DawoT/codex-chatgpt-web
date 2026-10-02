export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export function chatGptContextCompactionRequiredError(reason?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "Native context compaction is required before browser delivery. " +
      `${reason ? `${reason} ` : ""}` +
      "Compact the Codex context and retry this turn; the oversized prompt was not sent to ChatGPT.",
    {
      status: 413,
      errorType: "invalid_request_error",
      code: "context_compaction_required",
      retryable: false,
    },
  );
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  readonly diagnosticReason = "handoff_accepted";
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("The ChatGPT browser tab was closed, so the Codex turn was cancelled.", {
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  });
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("A newer Codex instruction superseded this ChatGPT response.", {
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  });
}

export function codexTurnBindingRetiredError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "Codex Native retired the turn binding before its tool work completed. The accepted ChatGPT turn cannot safely be replayed.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "codex_turn_binding_retired",
      retryable: false,
    },
  );
}

export function codexTurnBindingObservationFailedError(cause: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The bridge could not observe Codex Native turn retirement. Check the existing ChatGPT turn before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: "codex_turn_binding_observation_failed",
      retryable: false,
      cause,
    },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. " +
      "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptStreamInterruptedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT's response stream remained interrupted without corroborated progress. " +
      "The accepted turn was not replayed; inspect the existing ChatGPT response before continuing.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stream_interrupted",
      retryable: false,
    },
  );
}

export function chatGptToolProgressStalledError(detail: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A pending Codex tool call stayed in flight without new accredited progress and the bounded " +
      `stall budget expired. ${detail}`,
    {
      status: 504,
      errorType: "server_error",
      code: "chatgpt_tool_progress_stalled",
      retryable: false,
    },
  );
}

export function sessionReconciliationRequiredError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "Session actor requires reconciliation before another external effect. " +
      "The prior accepted operation has no confirmed result; inspect the existing ChatGPT turn before continuing.",
    {
      status: 409,
      errorType: "server_error",
      code: "session_reconciliation_required",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError("The retained ChatGPT conversation is no longer available.", {
    status: 409,
    errorType: "invalid_request_error",
    code: "compaction_source_unavailable",
    retryable: false,
  });
}
