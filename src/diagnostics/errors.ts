import { randomUUID } from "node:crypto";

/** Closed vocabulary: arbitrary messages, stacks, paths and request fragments never cross this boundary. */
export const DIAGNOSTIC_MESSAGES = {
  operation_failed: "Operation failed",
  aggregate_failure: "Multiple operations failed",
  abort_unknown: "Operation aborted for an unknown reason",
  user_cancelled: "ChatGPT web turn aborted",
  handoff_accepted: "Structured compaction handoff accepted",
  stage_timeout: "Browser stage deadline exceeded",
  browser_dom_observation_timeout: "Browser DOM observation deadline exceeded",
  compaction_handoff_failed: "Compaction handoff failed",
  transport_closed: "Transport closed",
  transport_reset: "Transport connection reset",
  transport_pipe: "Transport pipe closed",
  transport_refused: "Transport connection refused",
  transport_timeout: "Transport deadline exceeded",
  transport_error: "Transport operation failed",
  model_controls_unavailable: "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.",
  model_capabilities_changed: "Model capabilities changed since setup",
  model_control_not_ready: "Model or effort control did not become ready",
  model_slider_not_ready: "Effort slider did not become ready",
  model_snapshot_failed: "Effort slider state could not be read",
  model_effort_unavailable: "Requested effort is absent from the slider range",
  model_range_changed: "Effort range changed during selection",
  model_step_failed: "Effort slider did not move exactly one step",
  model_selection_changed: "Effort selection changed before commit",
  model_selection_not_persisted: "Effort selection did not persist after closing the menu",
  model_surface_changed: "Selected model browser surface changed before submission",
  model_label_changed: "Selected model label changed before submission",
  page_error: "Page script failed",
  page_crashed: "Page crashed",
  page_closed: "Page closed",
  page_request_failed: "Page request failed",
  diagnostic_capture_failed: "Diagnostic capture failed",
  helper_protocol_failure: "Browser helper protocol failed",
  client_cancelled: "ChatGPT web turn aborted",
  upstream_server_error: "ChatGPT upstream operation failed",
  chatgpt_effort_locked: "Requested effort requires an upgrade",
  chatgpt_turn_timeout: "ChatGPT turn deadline exceeded",
  chatgpt_stream_interrupted: "ChatGPT response stream remained interrupted",
  session_reconciliation_required: "Session requires reconciliation before another external effect",
  chatgpt_browser_transport_closed: "ChatGPT browser transport closed",
  compaction_handoff_timeout: "Compaction handoff deadline exceeded",
  codex_turn_binding_observation_failed: "Codex turn binding observation failed",
  codex_turn_binding_retired: "Codex turn binding retired",
  compaction_source_unavailable: "Compaction source unavailable",
  context_compaction_required: "Context compaction required",
  compaction_control_unavailable: "Compaction control unavailable",
  context_checkpoint_persistence_failed: "Context checkpoint persistence failed",
  context_checkpoint_validation_failed: "Context checkpoint validation failed",
  manual_handoff_timeout: "Manual handoff timeout",
  manual_launcher_failed: "Manual launcher failed",
  manual_turn_cancelled: "Manual turn cancelled",
  manual_multipart_unsupported: "Manual multipart unsupported",
  chatgpt_submission_not_accepted: "Chatgpt submission not accepted",
  chatgpt_browser_dom_unresponsive: "Chatgpt browser dom unresponsive",
  multipart_protocol_violation: "Multipart protocol violation",
  chatgpt_session_expired: "Chatgpt session expired",
  chatgpt_subscription_unavailable: "Chatgpt subscription unavailable",
  context_length_exceeded: "Context length exceeded",
  prompt_attachment_integrity: "Prompt attachment integrity",
  rate_limit_exceeded: "Rate limit exceeded",
  too_many_attachments: "Too many attachments",
  connector_not_found: "Connector not found",
  browser_stream_inconsistent: "Browser stream inconsistent",
  compaction_handoff_missing: "Compaction handoff missing",
  compaction_handoff_transport_limit: "Compaction handoff transport limit",
  compaction_repair_transport_limit: "Compaction repair transport limit",
  browser_interaction_mode_mismatch: "Browser interaction mode mismatch",
  mcp_result_too_large: "Mcp result too large",
  codex_tool_timeout: "Codex tool timeout",
  model_version_unavailable: "Model version unavailable",
  invalid_output_schema: "Invalid output schema",
  structured_output_validation_failed: "Structured output validation failed",
  chatgpt_tool_boundary_observation_timeout: "Chatgpt tool boundary observation timeout",
  helper_protocol_incompatible: "Browser helper protocol is incompatible",
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_MESSAGES;
export type DiagnosticErrorName = "Error" | "AggregateError" | "AbortError" | "TimeoutError" | "ChatGptWebAdapterError";

export interface DiagnosticErrorNode {
  errorId: string;
  name: DiagnosticErrorName;
  code: DiagnosticCode;
  message: string;
  status?: number;
  retryable?: boolean;
  causeErrorId?: string;
  aggregateErrorIds?: string[];
  nativeCode?: string;
  syscall?: string;
  facts?: DiagnosticFacts;
}

const NATIVE_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EDQUOT",
  "EROFS",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EEXIST",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EADDRINUSE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const SYSCALLS = new Set([
  "open",
  "read",
  "write",
  "fsync",
  "stat",
  "lstat",
  "mkdir",
  "rename",
  "unlink",
  "connect",
  "bind",
  "listen",
  "getaddrinfo",
]);

/** Flat acyclic graph preserves a shared cause once; root and child IDs originate at the producer. */
export interface DiagnosticErrorV1 {
  version: 1;
  errorId: string;
  nodes: DiagnosticErrorNode[];
  truncated: { depth: boolean; aggregate: boolean; bytes: boolean; cycle: boolean };
}

const MAX_BYTES = 16 * 1024;
const MAX_DEPTH = 8;
const MAX_AGGREGATE = 16;
const ids = new WeakMap<object, string>();
const captured = new WeakMap<object, DiagnosticErrorV1>();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function property(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

function object(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function errorId(value: unknown): string {
  if (!object(value)) return randomUUID();
  const existing = ids.get(value);
  if (existing) return existing;
  const id = randomUUID();
  ids.set(value, id);
  return id;
}

export function diagnosticCode(value: unknown): DiagnosticCode {
  if (object(value) && property(value, "diagnosticReason") === "handoff_accepted") return "handoff_accepted";
  const code = property(value, "code");
  if (typeof code === "string" && Object.hasOwn(DIAGNOSTIC_MESSAGES, code)) return code as DiagnosticCode;
  switch (code) {
    case "ECONNRESET":
      return "transport_reset";
    case "EPIPE":
      return "transport_pipe";
    case "ECONNREFUSED":
      return "transport_refused";
    case "ETIMEDOUT":
      return "transport_timeout";
  }
  const name = property(value, "name");
  if (name === "TimeoutError") return "stage_timeout";
  if (name === "AbortError") return "abort_unknown";
  if (name === "AggregateError") return "aggregate_failure";
  return "operation_failed";
}

function safeName(value: unknown): DiagnosticErrorName {
  const name = property(value, "name");
  return ["Error", "AggregateError", "AbortError", "TimeoutError", "ChatGptWebAdapterError"].includes(
    typeof name === "string" ? name : "",
  )
    ? (name as DiagnosticErrorName)
    : "Error";
}

const FACT_KEYS = [
  "expectedValue",
  "observedValue",
  "min",
  "max",
  "effortIndex",
  "expectedMin",
  "documentGeneration",
] as const;
export type DiagnosticFacts = Partial<Record<(typeof FACT_KEYS)[number], number>>;

function safeFacts(value: unknown): DiagnosticFacts | undefined {
  const facts: DiagnosticFacts = {};
  for (const key of FACT_KEYS) {
    const candidate = property(value, key);
    if (typeof candidate === "number" && Number.isFinite(candidate) && Math.abs(candidate) <= 1_000_000_000)
      facts[key] = candidate;
  }
  return Object.keys(facts).length ? facts : undefined;
}

export class DiagnosticSourceError extends Error {
  readonly facts?: DiagnosticFacts;
  constructor(
    readonly code: DiagnosticCode,
    options?: ErrorOptions & { facts?: DiagnosticFacts },
  ) {
    super(DIAGNOSTIC_MESSAGES[code], options);
    this.facts = safeFacts(options?.facts);
    if (code === "stage_timeout") this.name = "TimeoutError";
    if (code === "user_cancelled" || code === "abort_unknown" || code === "handoff_accepted") this.name = "AbortError";
    errorId(this);
  }
}

export function serializeDiagnosticError(value: unknown): DiagnosticErrorV1 {
  if (object(value) && captured.has(value)) return parseDiagnosticError(captured.get(value));
  const result: DiagnosticErrorV1 = {
    version: 1,
    errorId: errorId(value),
    nodes: [],
    truncated: { depth: false, aggregate: false, bytes: false, cycle: false },
  };
  const seen = new Map<object, string>();
  const active = new Set<object>();
  // Reserve space for edges and truncation flags as well as node bodies. No unbounded traversal.
  let remaining = MAX_BYTES - 512;
  const visit = (candidate: unknown, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) {
      result.truncated.depth = true;
      return undefined;
    }
    if (object(candidate) && active.has(candidate)) {
      result.truncated.cycle = true;
      return undefined;
    }
    if (object(candidate) && seen.has(candidate)) return seen.get(candidate);
    const code = diagnosticCode(candidate);
    const node: DiagnosticErrorNode = {
      errorId: depth === 0 ? result.errorId : errorId(candidate),
      name: safeName(candidate),
      code,
      message: DIAGNOSTIC_MESSAGES[code],
    };
    const status = property(candidate, "status");
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) node.status = status;
    const retryable = property(candidate, "retryable");
    if (typeof retryable === "boolean") node.retryable = retryable;
    const nativeCode = property(candidate, "code");
    if (typeof nativeCode === "string" && NATIVE_CODES.has(nativeCode)) node.nativeCode = nativeCode;
    const syscall = property(candidate, "syscall");
    if (typeof syscall === "string" && SYSCALLS.has(syscall)) node.syscall = syscall;
    const facts = safeFacts(property(candidate, "facts"));
    if (facts) node.facts = facts;
    const cost = Buffer.byteLength(JSON.stringify(node)) + 800;
    if (remaining < cost) {
      result.truncated.bytes = true;
      return undefined;
    }
    remaining -= cost;
    result.nodes.push(node);
    if (object(candidate)) {
      seen.set(candidate, node.errorId);
      active.add(candidate);
    }
    const cause = property(candidate, "cause");
    if (cause !== undefined) {
      const causeId = visit(cause, depth + 1);
      if (causeId) node.causeErrorId = causeId;
    }
    const children = property(candidate, "errors");
    if (Array.isArray(children)) {
      if (children.length > MAX_AGGREGATE) result.truncated.aggregate = true;
      node.aggregateErrorIds = [];
      for (let index = 0; index < Math.min(children.length, MAX_AGGREGATE); index += 1) {
        const childId = visit(property(children, String(index)), depth + 1);
        if (childId) node.aggregateErrorIds.push(childId);
      }
    }
    if (object(candidate)) active.delete(candidate);
    return node.errorId;
  };
  visit(value, 0);
  return result;
}

/** IPC is untrusted, even when a peer advertises this optional schema. */
export function parseDiagnosticError(value: unknown): DiagnosticErrorV1 {
  const fail = (): never => {
    throw new Error("Invalid diagnostic error graph");
  };
  if (!object(value) || property(value, "version") !== 1) return fail();
  const rootId = property(value, "errorId");
  const candidates = property(value, "nodes");
  if (
    typeof rootId !== "string" ||
    !UUID.test(rootId) ||
    !Array.isArray(candidates) ||
    candidates.length < 1 ||
    candidates.length > 80
  )
    return fail();
  const nodes: DiagnosticErrorNode[] = [];
  const known = new Set<string>();
  for (const candidate of candidates) {
    const id = property(candidate, "errorId");
    if (typeof id !== "string" || !UUID.test(id) || known.has(id)) return fail();
    known.add(id);
    const code = diagnosticCode(candidate);
    const node: DiagnosticErrorNode = {
      errorId: id,
      name: safeName(candidate),
      code,
      message: DIAGNOSTIC_MESSAGES[code],
    };
    const status = property(candidate, "status");
    if (status !== undefined) {
      if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) return fail();
      node.status = status;
    }
    const retryable = property(candidate, "retryable");
    if (retryable !== undefined) {
      if (typeof retryable !== "boolean") return fail();
      node.retryable = retryable;
    }
    const facts = safeFacts(property(candidate, "facts"));
    if (facts) node.facts = facts;
    const cause = property(candidate, "causeErrorId");
    const nativeCode = property(candidate, "nativeCode");
    if (typeof nativeCode === "string" && NATIVE_CODES.has(nativeCode)) node.nativeCode = nativeCode;
    const syscall = property(candidate, "syscall");
    if (typeof syscall === "string" && SYSCALLS.has(syscall)) node.syscall = syscall;
    if (cause !== undefined) {
      if (typeof cause !== "string" || !UUID.test(cause)) return fail();
      node.causeErrorId = cause;
    }
    const aggregate = property(candidate, "aggregateErrorIds");
    if (aggregate !== undefined) {
      if (
        !Array.isArray(aggregate) ||
        aggregate.length > MAX_AGGREGATE ||
        aggregate.some((id) => typeof id !== "string" || !UUID.test(id))
      )
        return fail();
      node.aggregateErrorIds = [...aggregate];
    }
    nodes.push(node);
  }
  const byId = new Map(nodes.map((node) => [node.errorId, node]));
  const active = new Set<string>();
  const reached = new Set<string>();
  const visitedDepth = new Map<string, number>();
  const walk = (id: string, depth: number): void => {
    const node = byId.get(id);
    if (!node || active.has(id) || depth > MAX_DEPTH) {
      fail();
      return;
    }
    // A DAG can contain exponentially many paths. Revisit only at a greater
    // depth so the longest path remains validated without re-expanding shared subgraphs.
    if ((visitedDepth.get(id) ?? -1) >= depth) return;
    visitedDepth.set(id, depth);
    active.add(id);
    reached.add(id);
    for (const child of [node.causeErrorId, ...(node.aggregateErrorIds ?? [])]) {
      if (child) walk(child, depth + 1);
    }
    active.delete(id);
  };
  walk(rootId, 0);
  if (reached.size !== nodes.length) return fail();
  const flags = property(value, "truncated");
  const result: DiagnosticErrorV1 = {
    version: 1,
    errorId: rootId,
    nodes,
    truncated: {
      depth: property(flags, "depth") === true,
      aggregate: property(flags, "aggregate") === true,
      bytes: property(flags, "bytes") === true,
      cycle: property(flags, "cycle") === true,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) return fail();
  return result;
}

export function deserializeDiagnosticError(value: unknown): Error {
  const graph = parseDiagnosticError(value);
  const instances = new Map<string, Error>();
  for (const node of graph.nodes) {
    const error = node.name === "AggregateError" ? new AggregateError([], node.message) : new Error(node.message);
    error.name = node.name;
    Object.assign(
      error,
      { code: node.code },
      node.status === undefined ? {} : { status: node.status },
      node.retryable === undefined ? {} : { retryable: node.retryable },
      node.facts === undefined ? {} : { facts: node.facts },
    );
    ids.set(error, node.errorId);
    instances.set(node.errorId, error);
  }
  for (const node of graph.nodes) {
    const error = instances.get(node.errorId)!;
    if (node.causeErrorId) error.cause = instances.get(node.causeErrorId);
    if (error instanceof AggregateError) error.errors = (node.aggregateErrorIds ?? []).map((id) => instances.get(id));
  }
  const root = instances.get(graph.errorId)!;
  captured.set(root, graph);
  return root;
}

/** Attach a peer's source graph to the public adapter wrapper without replacing its status/code contract. */
export function attachDiagnosticError(error: Error, value: unknown): void {
  const graph = parseDiagnosticError(value);
  ids.set(error, graph.errorId);
  captured.set(error, graph);
  const source = deserializeDiagnosticError(graph);
  if (source.cause !== undefined) error.cause = source.cause;
}
