/**
 * Sprint AF: Auto-Alert Webhook Dispatcher
 *
 * Non-blocking fire-and-forget webhook dispatcher for runtime alerts.
 * When the system detects degradation (e.g. janitor_consecutive_errors >= threshold),
 * it dispatches a structured JSON POST to a configurable webhook URL.
 *
 * Invariants:
 * - Dispatch is non-blocking: the caller awaits only the initial send, not delivery confirmation.
 * - If the webhook URL is unreachable or returns an error, the error is silently swallowed.
 * - Up to 2 retry attempts with 5-second timeout per attempt.
 * - If the alerts array is empty, no HTTP request is made (no-op).
 * - The CODEX_ALERT_WEBHOOK_URL environment variable configures the default webhook URL.
 */

import type { RuntimeAlert } from "./runtime-metrics";

export interface AlertWebhookPayload {
  event: "codex_chatgpt_web_alert";
  timestamp: string;
  daemon_pid: number;
  version: string;
  alerts: RuntimeAlert[];
}

export interface AlertWebhookOptions {
  daemonPid: number;
  version: string;
  /** Maximum number of retry attempts (default: 2) */
  maxRetries?: number;
  /** Timeout per attempt in milliseconds (default: 5000) */
  timeoutMs?: number;
}

/**
 * Dispatches a POST to the given webhook URL with the current alerts.
 * If alerts is empty, this is a no-op. Never throws.
 */
export async function dispatchAlertWebhook(
  webhookUrl: string,
  alerts: RuntimeAlert[],
  options: AlertWebhookOptions,
): Promise<void> {
  if (!webhookUrl || alerts.length === 0) return;

  const maxRetries = options.maxRetries ?? 2;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const payload: AlertWebhookPayload = {
    event: "codex_chatgpt_web_alert",
    timestamp: new Date().toISOString(),
    daemon_pid: options.daemonPid,
    version: options.version,
    alerts,
  };

  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "codex-chatgpt-web-alert/1.0" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      // Non-2xx: try to read body for logging then retry
      await res.text().catch(() => {});
    } catch {
      // Network error or timeout — retry silently
    }
  }
  // All attempts exhausted — silently give up
}

/**
 * Returns the configured webhook URL from the environment, or undefined if not set.
 */
export function getDefaultAlertWebhookUrl(): string | undefined {
  return process.env["CODEX_ALERT_WEBHOOK_URL"] || undefined;
}
