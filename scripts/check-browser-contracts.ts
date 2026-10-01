import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

type TestInvocation = {
  cmd: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type RunnerEffects = {
  executablePath?: () => string;
  runTests?: (invocation: TestInvocation) => Promise<number>;
};

const suites = [
  "tests/chatgpt-effort-browser.test.ts",
  "tests/browser-turn-binding.test.ts",
  "tests/chatgpt-limits-browser.test.ts",
  "tests/browser-response-dom.test.ts",
  "tests/browser-dom-events.test.ts",
  "tests/browser-dom-signal.test.ts",
];

/** Unlike the optional local tests, this entrypoint requires an installed browser. */
export async function runBrowserContracts(env: NodeJS.ProcessEnv = process.env, effects: RunnerEffects = {}) {
  let browserPath: string | undefined;
  try {
    browserPath = env.CHATGPT_DOM_TEST_BROWSER || (effects.executablePath ?? (() => chromium.executablePath()))();
    if (!browserPath) {
      throw new Error("Browser resolution returned an empty executable path");
    }
    if (!statSync(browserPath).isFile()) {
      throw new Error("Browser executable must be a regular file");
    }
    accessSync(browserPath, constants.X_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Browser preflight failed (${browserPath ?? "unresolved executable"}): ${reason}. ` +
        "Install with bunx --no-install playwright-core install --with-deps chromium " +
        "or set CHATGPT_DOM_TEST_BROWSER to an executable browser.",
      { cause: error },
    );
  }

  const invocation: TestInvocation = {
    cmd: [process.execPath, "test", ...suites],
    cwd: resolve(import.meta.dir, ".."),
    env: { ...env, CHATGPT_DOM_TEST_BROWSER: browserPath },
  };
  console.log(`Running browser contracts (${suites.length} suites) with ${browserPath}`);
  const runTests =
    effects.runTests ??
    (async ({ cmd, cwd, env }: TestInvocation) => {
      const child = Bun.spawn(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return child.exited;
    });
  return runTests(invocation);
}

if (import.meta.main) {
  try {
    process.exitCode = await runBrowserContracts();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
