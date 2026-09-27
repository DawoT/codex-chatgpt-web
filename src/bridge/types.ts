export interface OutputItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type ResponsesTerminalStatus = "completed" | "failed" | "incomplete";

export function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function sseEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export const PLAINTEXT_COLLABORATION_CALLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

/**
 * Codex MultiAgent V2 normally treats collaboration message arguments as backend ciphertext.
 * An empty encrypted_function_args list is the protocol's explicit plaintext-delivery marker.
 */
export function plaintextCollaborationFields(namespace: string | undefined, name: string): Record<string, unknown> {
  return namespace === "collaboration" && PLAINTEXT_COLLABORATION_CALLS.has(name)
    ? { encrypted_function_args: [] }
    : {};
}

// Freeform/custom tools (apply_patch) carry their body in `input`; the model is given a
// function with `{input:string}`, so unwrap it here when relaying back as a custom_tool_call.
export function freeformInput(args: string): string {
  try {
    const o = JSON.parse(args);
    if (o && typeof o.input === "string") return o.input;
  } catch {
    /* raw */
  }
  return args;
}

// Best-effort unwrap of a PARTIAL freeform arg buffer for live input streaming
// (`response.custom_tool_call_input.delta` — codex-rs uses it for UI preview only;
// the completed custom_tool_call item stays authoritative). Compact `{"input":"...`
// buffers get their string value progressively unescaped; anything else streams raw.
const FREEFORM_WRAP_PREFIX = '{"input":"';
export function freeformPartialInput(args: string): string {
  if (!args.startsWith(FREEFORM_WRAP_PREFIX)) return args;
  const body = args.slice(FREEFORM_WRAP_PREFIX.length);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"') break; // unescaped closing quote: value complete
    if (c === "\\") {
      const n = body[i + 1];
      if (n === undefined) break; // escape split across chunks: wait for more
      i++;
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u") {
        const hex = body.slice(i + 1, i + 5);
        if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else break; // incomplete \uXXXX: wait for more
      } else out += n; // \" \\ \/ etc.
    } else out += c;
  }
  return out;
}

// tool_search_call carries arguments as a JSON object ({query, limit}); parse the model's arg string.
export function parseArgsObj(args: string): Record<string, unknown> {
  try {
    const o = JSON.parse(args);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
