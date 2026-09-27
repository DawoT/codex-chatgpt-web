import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { assertCdpReady, readLauncherBrowserHostDescriptor } from "./descriptor";
import {
  LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS,
  LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS,
  type LauncherBrowserConnection,
  type LauncherBrowserHostDescriptor,
  type LauncherBrowserHostProfile,
} from "./types";

export async function selectLauncherPage(
  browser: Browser,
  descriptor: LauncherBrowserHostDescriptor,
  timeoutMs: number,
  surfaceId = descriptor.surfaceId,
  abortSignal?: AbortSignal,
): Promise<{ context: BrowserContext; page: Page }> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const targetId = descriptor.surfaceTargets[surfaceId];
  if (!targetId) throw new Error("Launcher browser surface is no longer registered with its native target");
  const deadline = Date.now() + timeoutMs;
  do {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const candidates = browser.contexts().flatMap(context => context.pages().map(page => ({ context, page })));
    const inspected = await Promise.all(candidates.map(async candidate => {
      const session = await candidate.context.newCDPSession(candidate.page).catch(() => undefined);
      if (!session) return { ...candidate, targetId: undefined };
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        return { ...candidate, targetId: targetInfo.targetId };
      } catch {
        return { ...candidate, targetId: undefined };
      } finally {
        await session.detach().catch(() => {});
      }
    }));
    const owned = inspected.filter(candidate => candidate.targetId === targetId);
    if (owned.length === 1) {
      return { context: owned[0].context, page: owned[0].page };
    }
    if (owned.length > 1) {
      throw new Error(`Launcher browser host exposed ${owned.length} surfaces with the same ownership id`);
    }
    // Re-check abort after the async CDP inspection round completes so that cancellation is
    // not delayed by the full duration of an in-flight Promise.all.
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Launcher browser host did not expose its owned browser surface");
}

export async function connectLauncherBrowserHost(
  descriptorPath: string,
  timeoutMs = 20_000,
  surfaceId?: string,
  abortSignal?: AbortSignal,
): Promise<LauncherBrowserConnection> {
  if (abortSignal?.aborted) {
    throw new DOMException("Launcher browser connection aborted", "AbortError");
  }
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  await assertCdpReady(descriptor, Math.min(timeoutMs, 5_000));
  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(descriptor.endpoint, { timeout: timeoutMs });
  } catch (error) {
    throw new Error(`Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`);
  }
  const closeOnAbort = () => { void browser.close().catch(() => {}); };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const { context, page } = await selectLauncherPage(
      browser,
      descriptor,
      timeoutMs,
      surfaceId,
      abortSignal,
    );
    return { descriptor, browser, context, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", closeOnAbort);
  }
}

export async function inspectLauncherBrowserHost(
  descriptorPath: string,
  options: {
    detectCapabilities?: boolean;
    expectedProfile?: LauncherBrowserHostProfile;
    timeoutMs?: number;
  } = {},
): Promise<{ solAvailable?: boolean; extraHighAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(
      `Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`,
    );
  }
  const timeoutMs = options.timeoutMs ?? (options.detectCapabilities
    ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS
    : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${descriptor.control.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.control.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ detectCapabilities: options.detectCapabilities === true }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || body.temporary !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid ChatGPT session evidence");
    }
    if (options.detectCapabilities
      && (typeof body.solAvailable !== "boolean" || typeof body.extraHighAvailable !== "boolean" || typeof body.proAvailable !== "boolean")) {
      throw new Error("Launcher did not return complete ChatGPT account capability evidence");
    }
    if (options.detectCapabilities && (body.proAvailable === true || body.extraHighAvailable === true) && body.solAvailable !== true) {
      throw new Error("Launcher returned contradictory ChatGPT account capability evidence");
    }
    return {
      url: body.url,
      ...(options.detectCapabilities ? {
        solAvailable: body.solAvailable as boolean,
        extraHighAvailable: body.extraHighAvailable as boolean,
        proAvailable: body.proAvailable as boolean,
      } : {}),
    };
  } catch (error) {
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Launcher ChatGPT session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
