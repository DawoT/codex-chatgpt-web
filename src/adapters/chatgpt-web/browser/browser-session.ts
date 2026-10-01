import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { loginVerificationMarkerPath } from "../../../browser-login";
import { DiagnosticSourceError, emitDiagnosticEvent } from "../../../diagnostics";
import { connectLauncherBrowserHost } from "../../../launcher-browser-host";
import type { ResolvedBrowserConfig } from "./config";
import { ChatGptPersistentBrowserStateError } from "./personalization";
import { type ChatGptSuspensionClock, chatGptSuspensionClock, remainingStageBudgetMs } from "./suspension-clock";

/**
 * Mutable browser/page lifecycle state shared between the worker and its composed
 * BrowserSession. The worker owns exactly one state object and hands it to the session, so
 * handles opened by the session (browser/context/page/managed-browser opening promise) are the
 * same objects the worker's accessors and `close()` observe, and the maintenance tail serialized
 * by `enqueueMaintenance` outlives individual calls.
 */
export interface BrowserSessionState {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  maintenanceTail: Promise<void>;
}

export interface BrowserSessionDeps {
  readonly config: ResolvedBrowserConfig;
  readonly state: BrowserSessionState;
  readonly activeRuns: Map<string, Promise<string>>;
}

export class BrowserSession {
  constructor(private readonly deps: BrowserSessionDeps) {}

  async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    emitDiagnosticEvent({
      producer: "browser",
      event: "stage_started",
      phase: "started",
      correlation: { turnId: traceId, traceId },
      fields: { stage },
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageTimedOut = false;
    let actionPromise: Promise<T> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          // A stage that spans a system sleep has not consumed its budget: the browser was as
          // frozen as this process, so slept time is refunded before the timer is re-armed.
          const suspendedMs = suspensionClock.suspendedMs() - suspendedAtStart;
          const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - startedAt, suspendedMs);
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          stageTimedOut = true;
          const reason = new DiagnosticSourceError("stage_timeout");
          reason.message = `ChatGPT browser stage timed out: ${stage}`;
          controller.abort(reason);
          rejectTimeout(reason);
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      emitDiagnosticEvent({
        producer: "browser",
        event: "stage_completed",
        phase: "reconciled",
        correlation: { turnId: traceId, traceId },
        fields: { stage, durationMs: performance.now() - startedAt },
      });
      return value;
    } catch (error) {
      let surfacedError = error;
      if (stageTimedOut && awaitAbortedActionSettlement && actionPromise) {
        try {
          await actionPromise;
        } catch (settlementError) {
          if (settlementError instanceof ChatGptPersistentBrowserStateError) {
            surfacedError = settlementError;
          }
        }
      }
      emitDiagnosticEvent(
        {
          producer: "browser",
          event: "stage_failed",
          phase: "failed",
          correlation: { turnId: traceId, traceId },
          fields: { stage, durationMs: performance.now() - startedAt },
          error: surfacedError,
        },
        { write: (event) => console.error(JSON.stringify(event)) },
      );
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.deps.state.maintenanceTail.then(() => {
      if (this.deps.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.deps.state.maintenanceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async ensurePage(): Promise<Page> {
    if (this.deps.state.page && !this.deps.state.page.isClosed()) return this.deps.state.page;
    if (this.deps.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.deps.config.browserHostDescriptorPath!);
      this.deps.state.browser = connection.browser;
      this.deps.state.context = connection.context;
      this.deps.state.page = connection.page;
      return this.deps.state.page;
    }
    if (
      !existsSync(this.deps.config.storageStatePath) ||
      !existsSync(loginVerificationMarkerPath(this.deps.config.storageStatePath))
    ) {
      throw new Error(`ChatGPT web login state is missing: ${this.deps.config.storageStatePath}`);
    }
    if (!existsSync(this.deps.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.deps.config.chromeExecutablePath}`);
    }
    this.deps.state.browser = await chromium.launch({
      executablePath: this.deps.config.chromeExecutablePath,
      headless: !this.deps.config.headed,
    });
    this.deps.state.context = await this.deps.state.browser.newContext({
      storageState: this.deps.config.storageStatePath,
    });
    this.deps.state.page = await this.deps.state.context.newPage();
    return this.deps.state.page;
  }

  async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.deps.state.managedBrowserReady) return this.deps.state.managedBrowserReady;
    const opening = (async () => {
      if (
        !existsSync(this.deps.config.storageStatePath) ||
        !existsSync(loginVerificationMarkerPath(this.deps.config.storageStatePath))
      ) {
        throw new Error(`ChatGPT web login state is missing: ${this.deps.config.storageStatePath}`);
      }
      if (!existsSync(this.deps.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.deps.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.deps.config.chromeExecutablePath,
        headless: !this.deps.config.headed,
      });
      const context = await browser.newContext({ storageState: this.deps.config.storageStatePath });
      this.deps.state.browser = browser;
      this.deps.state.context = context;
      return { browser, context };
    })();
    this.deps.state.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.deps.state.managedBrowserReady === opening) this.deps.state.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  async pageForNewTurn(): Promise<Page> {
    if (this.deps.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }
}
