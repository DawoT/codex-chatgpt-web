import { existsSync } from "node:fs";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { loginVerificationMarkerPath } from "../../../browser-login";
import { connectLauncherBrowserHost } from "../../../launcher-browser-host";
import type { ResolvedBrowserConfig } from "./config";
import { ChatGptPersistentBrowserStateError } from "./personalization";
import { type ChatGptSuspensionClock, chatGptSuspensionClock, remainingStageBudgetMs } from "./suspension-clock";

/**
 * Dispatch surface the browser/page lifecycle methods rely on through their `this`.
 * The worker owns the resolved browser configuration, the browser/context/page handles, the
 * managed-browser opening promise, the maintenance tail and the active run registry, and lends
 * them to the borrowed prototype dispatch, so stubs installed on the worker instance or on
 * `ChatGptBrowserWorker.prototype` keep steering every internal call.
 */
export interface ChatGptBrowserSessionHost {
  readonly config: ResolvedBrowserConfig;
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  maintenanceTail: Promise<void>;
  readonly activeRuns: Map<string, Promise<string>>;
  ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }>;
}

export class BrowserSession {
  async runStage<T>(
    this: ChatGptBrowserSessionHost,
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
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
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
          controller.abort();
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      console.info(
        `[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`,
      );
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
      console.error(
        `[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`,
      );
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  enqueueMaintenance<T>(this: ChatGptBrowserSessionHost, name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async ensurePage(this: ChatGptBrowserSessionHost): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (
      !existsSync(this.config.storageStatePath) ||
      !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))
    ) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  async ensureManagedBrowser(this: ChatGptBrowserSessionHost): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (
        !existsSync(this.config.storageStatePath) ||
        !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))
      ) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  async pageForNewTurn(this: ChatGptBrowserSessionHost): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }
}
