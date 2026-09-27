import type { AdapterEvent } from "../types";
import { adapterFailureFromMessage, classifyError, type CodexErrorPayload } from "../lib/errors";

export { adapterFailureFromMessage } from "../lib/errors";

export function responseError(status: number, type: string, message: string): CodexErrorPayload {
  return classifyError(status, type, message);
}

export function adapterFailureFromEvent(event: Extract<AdapterEvent, { type: "error" }>): { httpStatus: number; error: CodexErrorPayload } {
  if (event.status === undefined && event.errorType === undefined && event.code === undefined) {
    return adapterFailureFromMessage(event.message);
  }
  const fallback = adapterFailureFromMessage(event.message);
  const httpStatus = event.status ?? fallback.httpStatus;
  const error = classifyError(httpStatus, event.errorType ?? fallback.error.type, event.message);
  if (event.errorType !== undefined) error.type = event.errorType;
  if (event.code !== undefined) error.code = event.code;
  return { httpStatus, error };
}

export function formatErrorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: classifyError(status, type, message) }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
