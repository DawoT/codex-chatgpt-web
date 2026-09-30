/**
 * Shared builder for worker-prototype fixtures: the recurring
 * `Object.assign(Object.create(ChatGptBrowserWorker.prototype), {...})` pattern that worker tests
 * hand-rolled per suite (see browser-worker-contract, browser-worker-defects, turn-completion-loop,
 * browser-worker-launcher-contract, chatgpt-session, compaction-browser-recovery).
 *
 * The worker is never constructed with `new` in tests (the constructor reaches for browser
 * handles); instead the fixture hangs the fields the exercised path reads off the shared
 * prototype and relies on prototype methods steering through `this`. `makeWorkerFixture` supplies
 * the instance fields the real constructor always initializes (config, run registry, context
 * pressure registries) and replaces them with the given overrides; anything unmodeled goes
 * through `fields` (controller-host method stubs such as `runStage`, `prepareChatSurface`,
 * `responseDomSnapshot`, ...).
 *
 * Config defaults to `{ browserHost: "managed-chrome" }` — the dominant fixture — and stays a
 * partial on purpose: fixtures only carry the fields the exercised path reads, mirroring how the
 * hand-rolled versions worked. Launcher-host sites pass
 * `{ browserHost: "launcher", browserHostDescriptorPath: "..." }` and usually a `runBrowserTurn`
 * override; concurrency sites pass a gated `runExclusive`.
 *
 * Casting policy: each builder performs ONE documented boundary cast (see `browser-fakes.ts` for
 * the same policy on page fakes). Call sites receive a `ChatGptBrowserWorker` / `BrowserTurn` and
 * never cast; the cast absorbs that the fixtures implement the surface the exercised paths read,
 * not the worker's full private state.
 */
import type { Browser, Page } from "playwright-core";
import type { ResolvedBrowserConfig } from "../../src/adapters/chatgpt-web/browser/config";
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
  /** Merged (shallow) over the `{ browserHost: "managed-chrome" }` default. */
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
 * Builds a worker-prototype fixture. Defaults mirror a fresh worker's constructor state
 * (`managed-chrome` config, empty run registry, empty context pressure registries); overrides
 * replace them or hang additional fields on the fixture.
 */
export function makeWorkerFixture(overrides: WorkerFixtureOverrides = {}): ChatGptBrowserWorker {
  const fields: Record<string, unknown> = {
    config: { browserHost: "managed-chrome", ...overrides.config },
    activeRuns: overrides.activeRuns ?? new Map<string, Promise<string>>(),
    contextPressureByConversation:
      overrides.contextPressureByConversation ?? new Map<string, ChatGptBrowserContextPressure>(),
    contextPressureByPage: overrides.contextPressureByPage ?? new WeakMap<object, ChatGptBrowserContextPressure>(),
  };
  const modeled = new Set(["config", "activeRuns", "contextPressureByConversation", "contextPressureByPage"]);
  for (const [key, value] of Object.entries(overrides)) {
    if (!modeled.has(key) && value !== undefined) fields[key] = value;
  }
  Object.assign(fields, overrides.fields);
  // Factory-boundary cast: the fixture carries only the fields the exercised paths read, not the
  // worker's full private state. This is the only cast; call sites receive a typed worker.
  return Object.assign(Object.create(ChatGptBrowserWorker.prototype), fields) as unknown as ChatGptBrowserWorker;
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
