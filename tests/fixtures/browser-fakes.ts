/**
 * Shared typed fakes for the Playwright `Page`/`Locator` surfaces that the ChatGPT
 * browser worker drives.
 *
 * Before this fixture, every suite hand-rolled its own `Object.assign(new EventEmitter(), {...})
 * as unknown as Page` fake with a slightly different surface (see the `chainLocator()` /
 * `hiddenLocator()` copies in turn-completion-loop.test.ts, browser-worker-contract.test.ts and
 * turn-dom-signal-wait.test.ts). These builders centralize those shapes so a fake can be
 * configured per test with a small overrides object instead of rebuilt from scratch.
 *
 * Which worker code paths each fake supports:
 * - `fakeLocator` stands in for any selector chain: `filter/first/last/nth/getByText/getByTestId/
 *   getByRole/getByLabel/locator` are chainable and always return the same fake, while the
 *   behavior methods (`isVisible/count/press/evaluate/fill/waitFor/click/getAttribute/hover/...`)
 *   carry quiet defaults that tests override per scenario. It covers observation probes
 *   (`submissionDomState`, `responseDomSnapshot` call sites that refine via `filter`/`last`),
 *   overlay guards (`throwIfChatGptRateLimitDialog`, `throwIfChatGptSessionFailureAlert`) and
 *   composer helpers (`setChatGptThinkMode`, `selectConnector`).
 * - `fakePage` is `EventEmitter`-based, so the worker's `page.on(...)` / `page.off(...)`
 *   wiring (submission rejection observer, DOM event listeners) works on it. Defaults cover
 *   `isClosed`, `url`, `mainFrame`, `locator`, role/test-id/text lookups, a no-op keyboard
 *   (`model-controls.ts` presses Escape without a feature guard) and an `evaluate` that answers
 *   the DOM revision probe (`waitForChatGptDomRevision` args bag containing `attributeFilter`)
 *   with a stable verdict so event-driven waits resolve instead of hanging or crashing on
 *   `verdict.key`.
 * - `fakeSendComposer` builds the composer shape consumed by
 *   `ChatGptBrowserWorker.sendAttachedPrompt`: `composer.locator("xpath=ancestor::form[1]")`
 *   resolves to a form whose `locator(CHATGPT_SEND_BUTTON_SELECTOR).first()` (typed-Locator path)
 *   AND `getByTestId("send-button")` (legacy fallback behind the
 *   `typeof composerForm.locator === "function"` guard) both resolve to the same send button,
 *   so the guard can be deleted in production once fakes are type-complete. Reach the send
 *   button from a test through the same path the worker uses:
 *   `composer.locator("xpath=ancestor::form[1]").getByTestId("send-button")`.
 *
 * Casting policy: each builder performs ONE documented `as unknown as Page`/`as unknown as
 * Locator` cast at its own boundary. Call sites never cast — the returned fakes are already
 * typed as the real playwright-core interfaces. The fakes implement the surface the worker
 * actually uses, not the entirety of playwright-core, which is what the boundary cast absorbs.
 */
import { EventEmitter } from "node:events";
import type { Locator, Page } from "playwright-core";

type Awaitable<T> = T | Promise<T>;

export interface FakePressOptions {
  noWaitAfter?: boolean;
  timeout?: number;
  signal?: AbortSignal;
}

export interface FakeWaitForOptions {
  state?: "visible" | "attached" | "hidden" | "detached";
  timeout?: number;
  signal?: AbortSignal;
}

export interface FakeLocatorOverrides {
  // --- Behavior surface (each defaults to a quiet no-op) ---
  /** Hidden by default: the dominant "quiet page" pattern in the worker tests. */
  isVisible?: (options?: { timeout?: number }) => Awaitable<boolean>;
  isEnabled?: (options?: { timeout?: number }) => Awaitable<boolean>;
  isEditable?: (options?: { timeout?: number }) => Awaitable<boolean>;
  count?: (options?: { timeout?: number }) => Awaitable<number>;
  press?: (key: string, options?: FakePressOptions) => Promise<void>;
  pressSequentially?: (text: string, options?: { delay?: number }) => Promise<void>;
  /** Receives the raw page function plus its argument; override to script evaluation results. */
  evaluate?: (pageFunction: unknown, arg?: unknown, options?: unknown) => unknown;
  fill?: (value: string, options?: { timeout?: number }) => Promise<void>;
  waitFor?: (options?: FakeWaitForOptions) => Promise<void>;
  click?: (options?: { timeout?: number; noWaitAfter?: boolean; signal?: AbortSignal }) => Promise<void>;
  getAttribute?: (name: string, options?: { timeout?: number }) => Promise<string | null>;
  hover?: (options?: { timeout?: number }) => Promise<void>;
  focus?: (options?: { timeout?: number }) => Promise<void>;
  innerText?: (options?: { timeout?: number }) => Promise<string>;
  // --- Chainable refinement surface (each returns this fake unless overridden) ---
  // Overrides here are useful when a test must route by selector, e.g. returning a
  // dedicated locator for `[data-turn-id=` selectors while everything else stays hidden.
  filter?: (options?: { visible?: boolean; hasText?: string | RegExp }) => unknown;
  first?: () => unknown;
  last?: () => unknown;
  nth?: (index: number) => unknown;
  getByText?: (text: string | RegExp, options?: { exact?: boolean }) => unknown;
  getByTestId?: (testId: string) => unknown;
  getByRole?: (role: string, options?: { name?: string | RegExp; exact?: boolean; disabled?: boolean }) => unknown;
  getByLabel?: (text: string | RegExp, options?: { exact?: boolean }) => unknown;
  locator?: (selector: string, options?: { hasText?: string | RegExp }) => unknown;
  /** Owner-page back-reference used by `responseDomSnapshot` turn bindings; no default. */
  page?: () => unknown;
}

export interface FakePageOverrides {
  isClosed?: () => boolean;
  url?: () => string;
  /** See `defaultPageEvaluate`: answers DOM revision probes with a stable verdict by default. */
  evaluate?: (pageFunction: unknown, arg?: unknown, options?: unknown) => unknown;
  locator?: (selector: string, options?: { hasText?: string | RegExp }) => unknown;
  getByRole?: (role: string, options?: { name?: string | RegExp; exact?: boolean }) => unknown;
  getByTestId?: (testId: string) => unknown;
  getByText?: (text: string | RegExp, options?: { exact?: boolean }) => unknown;
  /** Stable frame object by default, matching the `mainFrame()` reference comparisons. */
  mainFrame?: () => unknown;
  goto?: (url: string, options?: unknown) => Promise<unknown>;
  reload?: (options?: unknown) => Promise<unknown>;
  bringToFront?: () => Promise<void>;
  /** No-op keyboard by default; `model-controls.ts` presses Escape without a feature guard. */
  keyboard?: {
    press?: (key: string, options?: FakePressOptions) => Promise<void>;
    insertText?: (text: string) => Promise<void>;
    type?: (text: string) => Promise<void>;
  };
  /** Resolves immediately by default (viewport probe path). */
  waitForFunction?: (pageFunction: unknown, arg?: unknown, options?: unknown) => Promise<unknown>;
}

/**
 * Answers the DOM revision probe (`waitForChatGptDomRevision` passes an args bag with an
 * `attributeFilter` array) with a stable `{ key, revision, timedOut }` verdict so callers
 * reading `verdict.key` get a value instead of a TypeError, and event-driven waits resolve
 * instead of hanging. Everything else evaluates to `undefined`.
 */
function defaultPageEvaluate(_pageFunction: unknown, arg?: unknown): unknown {
  if (
    arg !== null &&
    typeof arg === "object" &&
    Array.isArray((arg as { attributeFilter?: unknown }).attributeFilter)
  ) {
    return { key: "fake-page:0", revision: 0, timedOut: false };
  }
  return undefined;
}

/**
 * Builds a chainable fake `Locator`. Chainable refinements (`filter/first/last/nth/getByText/
 * getByTestId/getByRole/getByLabel/locator`) return the same fake so one object can stand in
 * for a whole selector chain; behavior methods carry quiet defaults (`isVisible: false`,
 * `count: 0`, no-op presses/waits) that the overrides replace wholesale.
 */
export function fakeLocator(overrides: FakeLocatorOverrides = {}): Locator {
  const locator: Record<string, unknown> = {
    // Chainable refinement surface.
    filter: (_options?: unknown) => locator,
    first: () => locator,
    last: () => locator,
    nth: (_index?: number) => locator,
    getByText: (_text?: unknown, _options?: unknown) => locator,
    getByTestId: (_testId?: unknown) => locator,
    getByRole: (_role?: unknown, _options?: unknown) => locator,
    getByLabel: (_text?: unknown, _options?: unknown) => locator,
    locator: (_selector?: unknown, _options?: unknown) => locator,
    // Behavior surface with quiet defaults.
    isVisible: async () => false,
    isEnabled: async () => true,
    isEditable: async () => true,
    count: async () => 0,
    press: async () => {},
    pressSequentially: async () => {},
    evaluate: async () => undefined,
    fill: async () => {},
    waitFor: async () => {},
    click: async () => {},
    getAttribute: async () => null,
    hover: async () => {},
    focus: async () => {},
    innerText: async () => "",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) locator[key] = value;
  }
  // Factory-boundary cast: the fake implements the surface the worker uses, not the entirety
  // of playwright-core's Locator. This is the only cast; call sites receive a typed Locator.
  return locator as unknown as Locator;
}

/**
 * Builds an `EventEmitter`-backed fake `Page`, so `page.on`/`page.off` and the worker's
 * browser DOM event wiring work out of the box. Defaults: not closed, `https://chatgpt.com/`,
 * a stable `mainFrame()` object, chainable locators for every lookup flavor, a no-op keyboard
 * and a DOM-revision-aware `evaluate` (see `defaultPageEvaluate`).
 */
export function fakePage(overrides: FakePageOverrides = {}): Page {
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    isClosed: () => false,
    url: () => "https://chatgpt.com/",
    evaluate: defaultPageEvaluate,
    locator: (_selector?: unknown, _options?: unknown) => fakeLocator(),
    getByRole: (_role?: unknown, _options?: unknown) => fakeLocator(),
    getByTestId: (_testId?: unknown) => fakeLocator(),
    getByText: (_text?: unknown, _options?: unknown) => fakeLocator(),
    mainFrame: () => frame,
    goto: async () => null,
    reload: async () => undefined,
    bringToFront: async () => {},
    keyboard: {
      press: async () => {},
      insertText: async () => {},
      type: async () => {},
    },
    waitForFunction: async () => undefined,
  });
  const writable = page as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) writable[key] = value;
  }
  // Factory-boundary cast: see the module doc block. Call sites receive a typed Page.
  return page as unknown as Page;
}

/**
 * Builds the composer shape consumed by `ChatGptBrowserWorker.sendAttachedPrompt`:
 * `composer.locator("xpath=ancestor::form[1]")` resolves to a form whose
 * `locator(send-button-selector).first()` (typed-Locator path) AND
 * `getByTestId("send-button")` (legacy fallback behind the
 * `typeof composerForm.locator === "function"` guard) both resolve to the same send button.
 * The send button defaults to visible + enabled with no-op `waitFor`/`press`; override it with
 * `sendButtonOverrides` (e.g. a stateful `press` counting submissions, or `isEnabled` flipping
 * after the first probe). Reach the button from a test via
 * `composer.locator("xpath=ancestor::form[1]").getByTestId("send-button")`.
 */
export function fakeSendComposer(sendButtonOverrides: FakeLocatorOverrides = {}): Locator {
  const sendButton = fakeLocator({
    isVisible: async () => true,
    isEnabled: async () => true,
    ...sendButtonOverrides,
  });
  // The form routes both the typed selector path and the legacy getByTestId fallback to the
  // same button so either production resolution converges on the same fake instance.
  const composerForm = fakeLocator({
    locator: (_selector?: unknown) => sendButton,
    getByTestId: (_testId?: unknown) => sendButton,
  });
  return fakeLocator({ locator: (_selector?: unknown) => composerForm });
}
