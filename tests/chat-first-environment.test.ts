import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CHAT_FIRST_CHATGPT_CONNECTOR_NAME,
  defaultConfig,
  expandUserPath,
  loadConfig,
  type AppConfig,
} from "../src/config";
import {
  CHAT_FIRST_SANDBOX_MODES,
  ChatFirstEnvironmentError,
  buildChatFirstEnvironment,
  resolveChatFirstWorkspace,
} from "../src/adapters/chatgpt-web/chat-first-environment";

const tempRoots: string[] = [];

afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cgw-chat-first-home-"));
  tempRoots.push(home);
  process.env.CODEX_CHATGPT_WEB_HOME = home;
  return home;
}

/** Writes a full valid config.json (defaultConfig plus overrides) and loads it through parseConfig. */
function writeConfig(chatFirst: unknown): AppConfig {
  const home = makeHome();
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...defaultConfig("browser-only"), chatFirst }));
  return loadConfig();
}

/** Hand-built in-memory config, bypassing disk, for builder/resolver unit tests. */
function configWith(chatFirst: AppConfig["chatFirst"]): AppConfig {
  return { ...defaultConfig("browser-only"), chatFirst };
}

function makeWorkspace(label: string): string {
  const workspace = mkdtempSync(join(tmpdir(), `cgw-chat-first-ws-${label}-`));
  tempRoots.push(workspace);
  return workspace;
}

function expectChatFirstError(fn: () => unknown): ChatFirstEnvironmentError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ChatFirstEnvironmentError);
    return error as ChatFirstEnvironmentError;
  }
  throw new Error("expected ChatFirstEnvironmentError");
}

describe("chat-first config contract", () => {
  test("exposes the chat-first connector identity", () => {
    expect(CHAT_FIRST_CHATGPT_CONNECTOR_NAME).toBe("Codex Chat-First");
  });

  test("lists the three supported sandbox modes", () => {
    expect([...CHAT_FIRST_SANDBOX_MODES]).toEqual(["readOnly", "workspaceWrite", "dangerFullAccess"]);
  });
});

describe("parseConfig chatFirst", () => {
  test("leaves chatFirst undefined when the block is absent", () => {
    expect(writeConfig(undefined).chatFirst).toBeUndefined();
  });

  test("defaults sandboxMode to dangerFullAccess and keeps enabled explicit", () => {
    expect(writeConfig({ enabled: true }).chatFirst).toEqual({ enabled: true, sandboxMode: "dangerFullAccess" });
  });

  test("accepts readOnly and dangerFullAccess without workspaces", () => {
    expect(writeConfig({ enabled: true, sandboxMode: "readOnly" }).chatFirst).toEqual({
      enabled: true,
      sandboxMode: "readOnly",
    });
    expect(writeConfig({ enabled: true, sandboxMode: "dangerFullAccess" }).chatFirst).toEqual({
      enabled: true,
      sandboxMode: "dangerFullAccess",
    });
  });

  test("normalizes workspaces to absolute resolved paths without requiring them on disk", () => {
    const home = makeHome();
    const absolute = join(home, "projects", "ws-a");
    const config = writeConfig({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [absolute, "~/codex-chatgpt-web-chat-first-ws"],
    });
    expect(config.chatFirst).toEqual({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [resolve(absolute), join(homedir(), "codex-chatgpt-web-chat-first-ws")],
    });
  });

  test("rejects workspaceWrite without at least one workspace", () => {
    expect(() => writeConfig({ enabled: true, sandboxMode: "workspaceWrite" }))
      .toThrow(/chatFirst\.workspaces/);
    expect(() => writeConfig({ enabled: true, sandboxMode: "workspaceWrite", workspaces: [] }))
      .toThrow(/chatFirst\.workspaces/);
  });

  test("rejects relative workspace entries", () => {
    expect(() => writeConfig({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: ["relative/path"],
    })).toThrow(/absolute/);
  });

  test("rejects an invalid sandboxMode", () => {
    expect(() => writeConfig({ enabled: true, sandboxMode: "yolo" })).toThrow(/chatFirst\.sandboxMode/);
  });

  test("requires an explicit boolean enabled", () => {
    expect(() => writeConfig({ sandboxMode: "readOnly" })).toThrow(/chatFirst\.enabled/);
    expect(() => writeConfig({ enabled: "yes", sandboxMode: "readOnly" })).toThrow(/chatFirst\.enabled/);
  });

  test("rejects a non-object chatFirst block", () => {
    expect(() => writeConfig("yes")).toThrow(/chatFirst/);
    expect(() => writeConfig(["readOnly"])).toThrow(/chatFirst/);
  });

  test("rejects non-string or empty workspace entries", () => {
    expect(() => writeConfig({ enabled: true, sandboxMode: "readOnly", workspaces: [42] }))
      .toThrow(/chatFirst\.workspaces/);
    expect(() => writeConfig({ enabled: true, sandboxMode: "readOnly", workspaces: ["   "] }))
      .toThrow(/chatFirst\.workspaces/);
  });

  test("enabled false parses fine but buildChatFirstEnvironment fails closed", () => {
    const config = writeConfig({ enabled: false, sandboxMode: "readOnly" });
    expect(config.chatFirst).toEqual({ enabled: false, sandboxMode: "readOnly" });
    expect(() => buildChatFirstEnvironment(config)).toThrow("chat-first is not enabled in config.json");
    expect(() => resolveChatFirstWorkspace(config)).toThrow("chat-first is not enabled in config.json");
  });
});

describe("buildChatFirstEnvironment", () => {
  test("throws when chatFirst is missing or disabled", () => {
    expectChatFirstError(() => buildChatFirstEnvironment(configWith(undefined)));
    expectChatFirstError(() => buildChatFirstEnvironment(configWith({ enabled: false, sandboxMode: "readOnly" })));
  });

  test("dangerFullAccess ignores workspaces and grants the full filesystem", () => {
    const workspace = makeWorkspace("danger");
    const environment = buildChatFirstEnvironment(configWith({
      enabled: true,
      sandboxMode: "dangerFullAccess",
      workspaces: [workspace],
    }));
    expect(environment).toEqual({
      cwd: homedir(),
      roots: ["/"],
      writableRoots: ["/"],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("workspaceWrite roots and writableRoots are the configured workspaces", () => {
    const wsA = makeWorkspace("a");
    const wsB = makeWorkspace("b");
    const environment = buildChatFirstEnvironment(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA, wsB],
    }));
    expect(environment).toEqual({
      cwd: wsA,
      roots: [wsA, wsB],
      writableRoots: [wsA, wsB],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [wsA, wsB], networkAccess: false },
      tools: [],
    });
  });

  test("readOnly never grants writable roots and does not promise network access", () => {
    const wsA = makeWorkspace("ro");
    const environment = buildChatFirstEnvironment(configWith({
      enabled: true,
      sandboxMode: "readOnly",
      workspaces: [wsA],
    }));
    expect(environment).toEqual({
      cwd: wsA,
      roots: [wsA],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [],
    });
  });

  test("readOnly without workspaces falls back to the home directory", () => {
    const environment = buildChatFirstEnvironment(configWith({ enabled: true, sandboxMode: "readOnly" }));
    expect(environment).toEqual({
      cwd: homedir(),
      roots: [homedir()],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [],
    });
  });

  test("workspaceWrite without workspaces fails closed even for hand-built configs", () => {
    const error = expectChatFirstError(() => buildChatFirstEnvironment(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
    })));
    expect(error.message).toMatch(/chatFirst\.workspaces/);
  });

  test("unsupported sandbox modes fail closed for hand-built configs", () => {
    const misconfigured = {
      ...defaultConfig("browser-only"),
      chatFirst: { enabled: true, sandboxMode: "yolo" },
    } as unknown as AppConfig;
    const error = expectChatFirstError(() => buildChatFirstEnvironment(misconfigured));
    expect(error.message).toMatch(/sandboxMode/);
  });
});

describe("resolveChatFirstWorkspace", () => {
  test("validates enabled before resolving", () => {
    expect(() => resolveChatFirstWorkspace(configWith(undefined), "/tmp"))
      .toThrow("chat-first is not enabled in config.json");
  });

  test("dangerFullAccess uses the home directory when no workspace is requested", () => {
    const resolved = resolveChatFirstWorkspace(configWith({
      enabled: true,
      sandboxMode: "dangerFullAccess",
    }));
    expect(resolved).toEqual({ cwd: homedir(), roots: ["/"], writableRoots: ["/"] });
  });

  test("dangerFullAccess accepts absolute and ~-expanded requested paths", () => {
    const config = configWith({ enabled: true, sandboxMode: "dangerFullAccess" });
    const absolute = join(tmpdir(), "cgw-chat-first-anywhere");
    expect(resolveChatFirstWorkspace(config, absolute)).toEqual({
      cwd: resolve(absolute),
      roots: ["/"],
      writableRoots: ["/"],
    });
    expect(resolveChatFirstWorkspace(config, "~/codex-chatgpt-web-chat-first-cwd")).toEqual({
      cwd: join(homedir(), "codex-chatgpt-web-chat-first-cwd"),
      roots: ["/"],
      writableRoots: ["/"],
    });
  });

  test("dangerFullAccess rejects relative requested paths", () => {
    const error = expectChatFirstError(() => resolveChatFirstWorkspace(
      configWith({ enabled: true, sandboxMode: "dangerFullAccess" }),
      "relative/path",
    ));
    expect(error.message).toMatch(/absolute path in dangerFullAccess mode/);
  });

  test("workspaceWrite defaults to the first workspace when nothing is requested", () => {
    const wsA = makeWorkspace("a");
    const wsB = makeWorkspace("b");
    expect(resolveChatFirstWorkspace(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA, wsB],
    }))).toEqual({ cwd: wsA, roots: [wsA, wsB], writableRoots: [wsA, wsB] });
  });

  test("workspaceWrite matches a requested workspace by exact normalized path", () => {
    const wsA = makeWorkspace("a");
    const wsB = makeWorkspace("b");
    const config = configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA, wsB],
    });
    const resolved = resolveChatFirstWorkspace(config, `${wsB}/`);
    expect(resolved.cwd).toBe(resolve(wsB));
    expect(resolved.roots).toEqual([wsA, wsB]);
    expect(resolved.writableRoots).toEqual([wsA, wsB]);
  });

  test("workspaceWrite matches a requested workspace by unique basename", () => {
    const wsA = makeWorkspace("alpha");
    const wsB = makeWorkspace("beta");
    const resolved = resolveChatFirstWorkspace(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA, wsB],
    }), basename(wsB));
    expect(resolved).toEqual({ cwd: wsB, roots: [wsA, wsB], writableRoots: [wsA, wsB] });
  });

  test("workspaceWrite accepts an absolute path contained in a workspace", () => {
    const wsA = makeWorkspace("a");
    mkdirSync(join(wsA, "sub", "dir"), { recursive: true });
    const nested = join(wsA, "sub", "dir");
    const resolved = resolveChatFirstWorkspace(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA],
    }), nested);
    expect(resolved).toEqual({ cwd: nested, roots: [wsA], writableRoots: [wsA] });
  });

  test("workspaceWrite rejects unmatched requests and lists the valid workspaces", () => {
    const wsA = makeWorkspace("a");
    const wsB = makeWorkspace("b");
    const error = expectChatFirstError(() => resolveChatFirstWorkspace(configWith({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: [wsA, wsB],
    }), "/definitely/not/a/configured/workspace"));
    expect(error.message).toMatch(/does not match any configured chat-first workspace/);
    expect(error.message).toContain(wsA);
    expect(error.message).toContain(wsB);
  });

  test("readOnly resolves like workspaceWrite but never grants writable roots", () => {
    const wsA = makeWorkspace("ro");
    const config = configWith({
      enabled: true,
      sandboxMode: "readOnly",
      workspaces: [wsA],
    });
    expect(resolveChatFirstWorkspace(config)).toEqual({ cwd: wsA, roots: [wsA], writableRoots: [] });
    const nested = join(wsA, "sub");
    expect(resolveChatFirstWorkspace(config, nested)).toEqual({
      cwd: nested,
      roots: [wsA],
      writableRoots: [],
    });
  });

  test("readOnly without workspaces defaults to home and matches requests inside it", () => {
    const config = configWith({ enabled: true, sandboxMode: "readOnly" });
    expect(resolveChatFirstWorkspace(config)).toEqual({
      cwd: homedir(),
      roots: [homedir()],
      writableRoots: [],
    });
    const nested = join(homedir(), "cgw-chat-first-inside-home");
    expect(resolveChatFirstWorkspace(config, nested)).toEqual({
      cwd: nested,
      roots: [homedir()],
      writableRoots: [],
    });
    expectChatFirstError(() => resolveChatFirstWorkspace(config, "/etc"));
  });

  test("resolves ~ workspaces normalized by parseConfig", () => {
    const home = makeHome();
    mkdirSync(join(home, "projects", "tilde-ws"), { recursive: true });
    const config = writeConfig({
      enabled: true,
      sandboxMode: "workspaceWrite",
      workspaces: ["~/cgw-chat-first-tilde-ws"],
    });
    const expected = join(homedir(), "cgw-chat-first-tilde-ws");
    expect(expandUserPath("~/cgw-chat-first-tilde-ws")).toBe(expected);
    expect(resolveChatFirstWorkspace(config, "cgw-chat-first-tilde-ws")).toEqual({
      cwd: expected,
      roots: [expected],
      writableRoots: [expected],
    });
  });
});
