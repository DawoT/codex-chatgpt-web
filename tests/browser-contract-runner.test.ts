import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function runCli(env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, "run", "scripts/check-browser-contracts.ts"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("missing explicit browser fails preflight instead of skipping the DOM suites", async () => {
  const directory = mkdtempSync(join(tmpdir(), "turn-lifecycle-b-browser-"));
  const browserPath = join(directory, "missing-browser");
  try {
    const result = await runCli({ CHATGPT_DOM_TEST_BROWSER: browserPath });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Browser preflight failed");
    expect(result.stderr).toContain(browserPath);
    expect(result.stdout).not.toContain("Running browser contracts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a directory cannot be used as the browser executable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "turn-lifecycle-b-browser-"));
  try {
    const result = await runCli({ CHATGPT_DOM_TEST_BROWSER: directory });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Browser preflight failed");
    expect(result.stderr).toContain("regular file");
    expect(result.stdout).not.toContain("Running browser contracts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("a non-executable file fails browser preflight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "turn-lifecycle-b-browser-"));
  const browserPath = join(directory, "browser");
  try {
    writeFileSync(browserPath, "not executable\n");
    chmodSync(browserPath, 0o600);
    const result = await runCli({ CHATGPT_DOM_TEST_BROWSER: browserPath });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Browser preflight failed");
    expect(result.stderr).toContain("executable");
    expect(result.stdout).not.toContain("Running browser contracts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([undefined, ""])("missing Playwright install fails when browser override is %p", async (override) => {
  const directory = mkdtempSync(join(tmpdir(), "turn-lifecycle-b-browser-"));
  try {
    const result = await runCli({
      CHATGPT_DOM_TEST_BROWSER: override,
      PLAYWRIGHT_BROWSERS_PATH: directory,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Browser preflight failed");
    expect(result.stderr).toContain(directory);
    expect(result.stderr).toContain("playwright-core install");
    expect(result.stdout).not.toContain("Running browser contracts");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the validated override reaches every DOM suite and preserves child environment", async () => {
  const { runBrowserContracts } = await import("../scripts/check-browser-contracts");
  const invocations: { cmd: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const result = await runBrowserContracts(
    { CHATGPT_DOM_TEST_BROWSER: process.execPath, CONTRACT_TEST_MARKER: "preserved" },
    {
      executablePath: () => {
        throw new Error("Explicit override must take precedence");
      },
      runTests: async (invocation) => {
        invocations.push(invocation);
        return 0;
      },
    },
  );
  expect(result).toBe(0);
  expect(invocations).toEqual([
    {
      cmd: [
        process.execPath,
        "test",
        "tests/chatgpt-effort-browser.test.ts",
        "tests/browser-turn-binding.test.ts",
        "tests/chatgpt-limits-browser.test.ts",
        "tests/browser-response-dom.test.ts",
        "tests/browser-dom-events.test.ts",
        "tests/browser-dom-signal.test.ts",
      ],
      cwd: root,
      env: { CHATGPT_DOM_TEST_BROWSER: process.execPath, CONTRACT_TEST_MARKER: "preserved" },
    },
  ]);
});

test.each([undefined, ""])("valid Playwright fallback reaches the child when override is %p", async (override) => {
  const { runBrowserContracts } = await import("../scripts/check-browser-contracts");
  const browserPaths: (string | undefined)[] = [];
  await runBrowserContracts(
    { CHATGPT_DOM_TEST_BROWSER: override },
    {
      executablePath: () => process.execPath,
      runTests: async ({ env }) => {
        browserPaths.push(env.CHATGPT_DOM_TEST_BROWSER);
        return 0;
      },
    },
  );
  expect(browserPaths).toEqual([process.execPath]);
});

test("failed resolution never starts the optional DOM tests", async () => {
  const { runBrowserContracts } = await import("../scripts/check-browser-contracts");
  let childStarts = 0;
  await expect(
    runBrowserContracts(
      {},
      {
        executablePath: () => {
          throw new Error("browser resolution unavailable");
        },
        runTests: async () => {
          childStarts += 1;
          return 0;
        },
      },
    ),
  ).rejects.toThrow("browser resolution unavailable");
  expect(childStarts).toBe(0);
});

test("a failed DOM suite propagates the child exit code", async () => {
  const { runBrowserContracts } = await import("../scripts/check-browser-contracts");
  const result = await runBrowserContracts(
    { CHATGPT_DOM_TEST_BROWSER: process.execPath },
    {
      runTests: async () => {
        return 7;
      },
    },
  );
  expect(result).toBe(7);
});
