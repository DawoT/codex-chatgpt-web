/**
 * Browser-boundary fakes for the Page and Locator APIs exercised by real worker
 * instances. Selector refinements share a locator unless a scenario overrides
 * their routing; browser actions have asynchronous defaults.
 *
 * Boundary casts cover the unexercised Playwright API. Tests receive typed
 * Page/Locator values and configure browser state or failures explicitly.
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
  allInnerTexts?: () => Promise<string[]>;
  setInputFiles?: Locator["setInputFiles"];
  // --- Chainable refinement surface (each returns this fake unless overridden) ---
  // Overrides here are useful when a test must route by selector, e.g. returning a
  // dedicated locator for `[data-turn-id=` selectors while everything else stays hidden.
  filter?: (options?: { visible?: boolean; hasText?: string | RegExp }) => unknown;
  first?: () => unknown;
  last?: () => unknown;
  nth?: (index: number) => unknown;
  or?: (other: Locator) => unknown;
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
async function defaultPageEvaluate(_pageFunction: unknown, arg?: unknown): Promise<unknown> {
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
    or: (_other: Locator) => locator,
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
    allInnerTexts: async () => [],
    setInputFiles: async () => {},
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
    if (value === undefined) continue;
    if (key === "keyboard") {
      Object.assign(page.keyboard, value);
    } else {
      writable[key] = value;
    }
  }
  // Factory-boundary cast: see the module doc block. Call sites receive a typed Page.
  return page as unknown as Page;
}

/**
 * Composer fixture with an owned form and a visible, enabled send button.
 * Form selector and test-id lookups resolve to the same browser element.
 */
export function fakeSendComposer(sendButtonOverrides: FakeLocatorOverrides = {}): Locator {
  const sendButton = fakeLocator({
    isVisible: async () => true,
    isEnabled: async () => true,
    ...sendButtonOverrides,
  });
  // Both browser lookup APIs resolve the same send button within the owned form.
  const composerForm = fakeLocator({
    locator: (_selector?: unknown) => sendButton,
    getByTestId: (_testId?: unknown) => sendButton,
  });
  return fakeLocator({ locator: (_selector?: unknown) => composerForm });
}
