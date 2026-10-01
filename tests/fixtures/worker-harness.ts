/**
 * Test boundary for constructing a genuine worker without the shared provider registry.
 * Configuration is fully resolved. Browser resources are acquired lazily; supplied handles
 * seed the same session state used by the composed BrowserSession.
 * Focused tests may override orchestration dependencies through fields, but the behavior
 * under test must remain the real worker/controller implementation.
 */
import type { Browser, Page } from "playwright-core";
import type { BrowserSessionState } from "../../src/adapters/chatgpt-web/browser/browser-session";
import { type ResolvedBrowserConfig, resolveBrowserConfig } from "../../src/adapters/chatgpt-web/browser/config";
import type { ChatGptBrowserContextPressure } from "../../src/adapters/chatgpt-web/browser/context-pressure";
import { type BrowserTurn, ChatGptBrowserWorker } from "../../src/adapters/chatgpt-web/browser-worker";
import type { LauncherBrowserHelperClient } from "../../src/adapters/chatgpt-web/launcher-helper-client";
import { CHATGPT_WEB_MODEL_ID } from "../../src/adapters/chatgpt-web/model";

/** Real `runBrowserTurn` signature; stubs accepting fewer parameters stay assignable. */
export type WorkerFixtureRunBrowserTurn = (
  turn: BrowserTurn,
  launcherSurfaceId?: string,
  maintenancePage?: Page,
  reuseConversation?: boolean,
  trackUsage?: boolean,
  onInteractiveSettled?: () => void,
  acquireInteractive?: () => Promise<void>,
) => Promise<string>;

export interface WorkerFixtureOverrides {
  /** Merged over a complete resolved managed-browser configuration. */
  config?: Partial<ResolvedBrowserConfig>;
  /** Replaces the default empty run registry wholesale. */
  activeRuns?: Map<string, Promise<string>>;
  /** Replaces the default empty per-conversation pressure registry wholesale. */
  contextPressureByConversation?: Map<string, ChatGptBrowserContextPressure>;
  /** Replaces the default empty per-page pressure registry wholesale. */
  contextPressureByPage?: WeakMap<object, ChatGptBrowserContextPressure>;
  /** Launcher helper stub; only the launcher-host paths read it. */
  launcherHelper?: Pick<LauncherBrowserHelperClient, "close" | "run">;
  /** Pending maintenance work that `close()` must await before teardown. */
  maintenanceTail?: Promise<void>;
  /** Browser handle stub; `close()` is the only behavior any fixture exercises on it. */
  browser?: Pick<Browser, "close">;
  /** Loose handles for `close()` teardown assertions; fixtures use marker objects. */
  context?: Record<string, unknown>;
  page?: Record<string, unknown>;
  /** Managed-browser startup promise stub read by the session lifecycle paths. */
  managedBrowserReady?: Promise<{ browser: unknown; context: unknown }>;
  /** Concurrency gate override; the real prototype method is left in place when omitted. */
  runExclusive?: (turn: BrowserTurn) => Promise<string>;
  /** Full turn-pipeline override; see `WorkerFixtureRunBrowserTurn`. */
  runBrowserTurn?: WorkerFixtureRunBrowserTurn;
  /** Escape hatch for controller-host method stubs not modeled above; applied last, verbatim. */
  fields?: Record<string, unknown>;
}

/**
 * Builds a real worker fixture without touching the shared provider registry. Defaults mirror a
 * fresh worker's constructor state
 * (`managed-chrome` config, empty run registry, empty context pressure registries); overrides
 * replace them or hang additional fields on the fixture.
 */
export function makeWorkerFixture(overrides: WorkerFixtureOverrides = {}): ChatGptBrowserWorker {
  const { fields: extra = {}, ...modeled } = overrides;
  const fields: Record<string, unknown> = { ...modeled, ...extra };
  const config = {
    ...resolveBrowserConfig({ adapter: "chatgpt-web", baseUrl: "browser://test-fixture", chatgptWeb: {} }),
    ...(fields.config as Partial<ResolvedBrowserConfig> | undefined),
  };
  delete fields.config;
  const sessionState = {
    maintenanceTail: Promise.resolve(),
    ...(fields.sessionState as BrowserSessionState | undefined),
  };
  for (const key of ["browser", "context", "page", "managedBrowserReady", "maintenanceTail"] as const) {
    if (fields[key] !== undefined) {
      Object.assign(sessionState, { [key]: fields[key] });
      delete fields[key];
    }
  }
  // The constructor is private only at the TypeScript API boundary. Reflect.construct runs
  // every real field initializer and avoids registering the fixture as a provider singleton.
  const worker = Reflect.construct(ChatGptBrowserWorker, [config]) as ChatGptBrowserWorker;
  Object.assign(worker, { ...fields, sessionState });
  return worker;
}

/**
 * Builds the recurring `BrowserTurn` shared by the hand-rolled builders (`baseBrowserTurn` in
 * browser-worker-defects and browser-worker-launcher-contract, the inline `browserTurn()` builders
 * in browser-worker-contract): the fixed `CHATGPT_WEB_MODEL_ID` model id, the quiet capability
 * bag, a `prepare` that yields the trace id as prompt text, and a no-op text delta sink. Every
 * field is overridable; `prepare` overrides should still release their prompt.
 */
export function makeLauncherTurn(traceId: string, overrides: Partial<BrowserTurn> = {}): BrowserTurn {
  return {
    traceId,
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
    // Quiet prompt: the exercised paths read `text`/`images` and call `release`; the rest of
    // `CompiledChatGptWebPrompt` stays absent, which the boundary cast absorbs.
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
    ...overrides,
  } as BrowserTurn;
}
