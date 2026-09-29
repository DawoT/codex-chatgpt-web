import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { assertCdpReady, readLauncherBrowserHostDescriptor } from "./descriptor";
import {
  LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS,
  LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS,
  type LauncherBrowserConnection,
  type LauncherBrowserHostDescriptor,
  type LauncherBrowserHostProfile,
} from "./types";

function resolveAppName(optionsAppName?: string): string {
  if (optionsAppName?.trim()) return optionsAppName.trim();
  try {
    const configPath = join(homedir(), ".codex-chatgpt-web", "config.json");
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { appName?: string };
      if (typeof parsed?.appName === "string" && parsed.appName.trim()) return parsed.appName.trim();
    }
  } catch {
    // ignore
  }
  return "Codex Native2";
}

function resolveBrowserHelperScript(descriptor: LauncherBrowserHostDescriptor): string | undefined {
  const entrypoint = process.argv[1];
  if (typeof entrypoint === "string") {
    const sibling = join(dirname(entrypoint), "browser-helper.cjs");
    if (existsSync(sibling)) return sibling;
  }
  const projectDist = join(process.cwd(), "dist", "browser-helper.cjs");
  if (existsSync(projectDist)) return projectDist;
  const versionsDir = join(homedir(), ".codex-chatgpt-web", "versions");
  if (existsSync(versionsDir)) {
    try {
      const dirs = readdirSync(versionsDir).filter(
        (d) => d.includes("linux") || d.includes("darwin") || d.includes("win"),
      );
      for (const dir of dirs.sort().reverse()) {
        const candidate = join(versionsDir, dir, "app", "browser-helper.cjs");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }
  if (existsSync(descriptor.helper.script)) return descriptor.helper.script;
  return undefined;
}

async function inspectLauncherBrowserHostViaHelper(
  descriptor: LauncherBrowserHostDescriptor,
  descriptorPath: string,
  options: { detectCapabilities?: boolean; timeoutMs?: number; appName?: string },
): Promise<{ solAvailable?: boolean; extraHighAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const helperScript = resolveBrowserHelperScript(descriptor);
  if (!helperScript || !existsSync(descriptor.helper.executable)) {
    throw new Error("Launcher browser helper executable or script is missing");
  }

  const timeoutMs =
    options.timeoutMs ??
    (options.detectCapabilities ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const appName = resolveAppName(options.appName);

  const child = spawn(descriptor.helper.executable, [helperScript], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const id = `inspect-${randomBytes(12).toString("hex")}`;
  return new Promise((resolve, reject) => {
    let completed = false;
    const timer = setTimeout(
      () => {
        if (completed) return;
        completed = true;
        child.kill();
        reject(new Error(`helper session inspection timed out after ${timeoutMs}ms`));
      },
      Math.min(timeoutMs, 30_000),
    );

    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else {
        if (value?.authenticated !== true || value.temporary !== true || typeof value.url !== "string") {
          reject(new Error("Launcher helper returned invalid ChatGPT session evidence"));
          return;
        }
        if (
          options.detectCapabilities &&
          (typeof value.solAvailable !== "boolean" ||
            typeof value.extraHighAvailable !== "boolean" ||
            typeof value.proAvailable !== "boolean")
        ) {
          reject(new Error("Launcher helper did not return complete ChatGPT account capability evidence"));
          return;
        }
        if (
          options.detectCapabilities &&
          (value.proAvailable === true || value.extraHighAvailable === true) &&
          value.solAvailable !== true
        ) {
          reject(new Error("Launcher helper returned contradictory ChatGPT account capability evidence"));
          return;
        }
        resolve({
          url: value.url as string,
          ...(options.detectCapabilities
            ? {
                solAvailable: value.solAvailable as boolean,
                extraHighAvailable: value.extraHighAvailable as boolean,
                proAvailable: value.proAvailable as boolean,
              }
            : {}),
        });
      }
    };

    const output = createInterface({ input: child.stdout });
    output.on("line", (line) => {
      try {
        const msg = JSON.parse(line) as {
          type?: string;
          id?: string;
          value?: Record<string, unknown>;
          message?: string;
        };
        if (msg.type === "ready") {
          child.stdin.write(
            `${JSON.stringify({
              type: "inspect",
              id,
              detectCapabilities: options.detectCapabilities === true,
              config: {
                appName,
                browserHostDescriptorPath: descriptorPath,
              },
            })}\n`,
          );
        } else if (msg.id === id) {
          if (msg.type === "result") finish(null, msg.value);
          else finish(new Error(msg.message || "Launcher helper inspection returned error"));
        }
      } catch {
        // ignore non-json
      }
    });

    child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    child.on("exit", (code, signal) => {
      if (!completed)
        finish(
          new Error(`Launcher browser helper exited prematurely (${signal ? `signal ${signal}` : `status ${code}`})`),
        );
    });
  });
}

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
    const candidates = browser.contexts().flatMap((context) => context.pages().map((page) => ({ context, page })));
    const inspected = await Promise.all(
      candidates.map(async (candidate) => {
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
      }),
    );
    const owned = inspected.filter((candidate) => candidate.targetId === targetId);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
    throw new Error(
      `Could not connect Playwright to the launcher browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const closeOnAbort = () => {
    void browser.close().catch(() => {});
  };
  abortSignal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    if (abortSignal?.aborted) {
      throw new DOMException("Launcher browser connection aborted", "AbortError");
    }
    const { context, page } = await selectLauncherPage(browser, descriptor, timeoutMs, surfaceId, abortSignal);
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
    appName?: string;
  } = {},
): Promise<{ solAvailable?: boolean; extraHighAvailable?: boolean; proAvailable?: boolean; url: string }> {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
  if (options.expectedProfile && descriptor.profile !== options.expectedProfile) {
    throw new Error(`Launcher browser belongs to ${descriptor.profile}, but ${options.expectedProfile} was required`);
  }
  const timeoutMs =
    options.timeoutMs ??
    (options.detectCapabilities ? LAUNCHER_CAPABILITY_INSPECTION_TIMEOUT_MS : LAUNCHER_SESSION_INSPECTION_TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const httpTimeoutMs = timeoutMs >= 10_000 ? Math.min(timeoutMs, 5_000) : timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, httpTimeoutMs);
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
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
    if (body.authenticated !== true || body.temporary !== true || typeof body.url !== "string") {
      throw new Error("Launcher returned invalid ChatGPT session evidence");
    }
    if (
      options.detectCapabilities &&
      (typeof body.solAvailable !== "boolean" ||
        typeof body.extraHighAvailable !== "boolean" ||
        typeof body.proAvailable !== "boolean")
    ) {
      throw new Error("Launcher did not return complete ChatGPT account capability evidence");
    }
    if (
      options.detectCapabilities &&
      (body.proAvailable === true || body.extraHighAvailable === true) &&
      body.solAvailable !== true
    ) {
      throw new Error("Launcher returned contradictory ChatGPT account capability evidence");
    }
    return {
      url: body.url,
      ...(options.detectCapabilities
        ? {
            solAvailable: body.solAvailable as boolean,
            extraHighAvailable: body.extraHighAvailable as boolean,
            proAvailable: body.proAvailable as boolean,
          }
        : {}),
    };
  } catch (error) {
    if (timeoutMs >= 10_000) {
      try {
        return await inspectLauncherBrowserHostViaHelper(descriptor, descriptorPath, options);
      } catch {
        // Fallback failed as well, proceed to throw standard error
      }
    }
    const detail = timedOut
      ? `session inspection timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    throw new Error(`Launcher ChatGPT session could not be verified: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}
