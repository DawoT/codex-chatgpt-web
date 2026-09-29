import { AGENT_WAIT_TRANSPORT_RULE, CHATGPT_WEB_AGENT_WAIT_POLL_MS } from "./instructions";
import { boundedSessionArguments } from "./session-yield";
import { GATEWAY_AGENT_WAIT_TOOL_NAMES, gatewayToolNameIsValid, isGatewayAgentWaitTool } from "./tool-visibility";
import type { GatewayToolCatalogPage, GatewayToolDescriptor } from "./types";

export function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

export function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (!isGatewayAgentWaitTool(tool.name)) return tool.description;
  return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}`;
}

export function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native nested tool registry is unavailable");',
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visibleName = name => {",
    '  return typeof name === "string" && /^[A-Za-z0-9_$]+$/.test(name) && !excludedNames.has(name);',
    "};",
    "const matches = ALL_TOOLS",
    "  .filter(tool => visibleName(tool?.name))",
    '  .map(tool => ({ name: tool.name, description: typeof tool.description === "string" ? tool.description : "" }))',
    '  .filter(tool => !needle || (tool.name + "\\n" + tool.description).toLowerCase().includes(needle));',
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

export function gatewayToolCatalogPage(
  response: {
    content: unknown[];
    isError?: boolean;
  },
  excludedNames: ReadonlySet<string>,
): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map((item) =>
      item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined,
    )
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  if (Buffer.byteLength(textBlocks[0]!, "utf8") > 1024 * 1024) {
    throw new Error("Native nested tool inventory exceeds the 1 MiB response budget");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (
      typeof tool.name !== "string" ||
      typeof tool.description !== "string" ||
      !gatewayToolNameIsValid(tool.name) ||
      excludedNames.has(tool.name)
    ) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

export function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    '  if (value && typeof value === "object") {',
    '    if (value.type === "image") { image(value); return; }',
    '    if (value.type === "audio") { audio(value); return; }',
    '    if (value.type === "text" && typeof value.text === "string") { text(value.text); return; }',
    '    if (typeof value.image_url === "string" && typeof value.output_hint === "string") { generatedImage(value); return; }',
    '    if (typeof value.image_url === "string") { image(value.image_url, value.detail ?? "auto"); return; }',
    '    if (typeof value.audio_url === "string") { audio(value.audio_url); return; }',
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not available in this turn: ${nestedToolName}`);
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform
    ? (payload.input ?? "")
    : boundedSessionArguments(nestedToolName, payload.arguments ?? {});
  return execGatewayResultProgram([
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native nested tool registry is unavailable");',
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    'if (excludedNames.has(nestedToolName)) throw new Error("Native nested tool is not callable through the structured gateway");',
    'if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error("Native nested tool is not listed in this turn");',
    "const nestedTool = tools[nestedToolName];",
    'if (typeof nestedTool !== "function") throw new Error("Native nested tool is listed but unavailable");',
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface. Session waits are bounded in the
 * proxy, and a long script yields a running cell while its awaited work continues.
 * This keeps a sequence of short native calls from occupying one MCP request
 * until the tunnel deadline. The caller must continue the returned cell.
 */
export function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    'const __cgwYieldTimer = typeof yield_control === "function"',
    "  ? setTimeout(() => { void Promise.resolve(yield_control()).catch(() => {}); }, 30_000)",
    "  : undefined;",
    "try {",
    "  await (async (tools) => {",
    input,
    "  })((() => {",
    "  const source = tools;",
    `  const boundSession = ${boundedSessionArguments.toString()};`,
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set(Reflect.ownKeys(source));",
    '  if (typeof ALL_TOOLS !== "undefined" && Array.isArray(ALL_TOOLS)) {',
    '    for (const tool of ALL_TOOLS) if (typeof tool?.name === "string") registryNames.add(tool.name);',
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    '    if (typeof value === "function" && name === blockedExecName) {',
    '      exposed = () => { throw new Error("Nested raw exec is unavailable inside ChatGPT Web exec"); };',
    '    } else if (typeof value === "function" && typeof name === "string" && waitNames.has(name)) {',
    "      exposed = args => {",
    '        if (!args || typeof args !== "object" || Array.isArray(args) || args.timeout_ms !== pollMs) {',
    '          throw new Error("ChatGPT Web wait_agent requires timeout_ms=" + pollMs + " so the shared MCP channel remains available to spawned Web agents");',
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    '    } else if (typeof value === "function" && (name === "exec_command" || name === "write_stdin")) {',
    "      exposed = args => Reflect.apply(value, source, [boundSession(name, args)]);",
    '    } else if (typeof value === "function") {',
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "  })());",
    "} finally {",
    "  if (__cgwYieldTimer !== undefined) clearTimeout(__cgwYieldTimer);",
    "}",
  ].join("\n");
}

export function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    'if (typeof ALL_TOOLS === "undefined" || !Array.isArray(ALL_TOOLS)) throw new Error("Native command tool registry is unavailable");',
    "const nativeCommandNames = new Set(ALL_TOOLS.map(tool => tool?.name));",
    `const nativeCommandCandidates = ${JSON.stringify([execCommandName, shellCommandName])}.filter(name => nativeCommandNames.has(name));`,
    'if (nativeCommandCandidates.length !== 1) throw new Error("Expected exactly one native command tool; found " + (nativeCommandCandidates.join(", ") || "none"));',
    "const nativeCommandName = nativeCommandCandidates[0];",
    "const nativeCommand = tools[nativeCommandName];",
    'if (typeof nativeCommand !== "function") throw new Error("Native command tool " + nativeCommandName + " is listed but unavailable");',
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(boundedSessionArguments("exec_command", execCommandArguments))} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}
