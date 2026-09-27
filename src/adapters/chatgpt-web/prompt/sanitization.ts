import type { CodexMessage } from "../../../types";

const RETIRED_TURN_HANDLE = /(?<![A-Za-z0-9_-])(turn|request|binding)_[A-Za-z0-9_-]{32}(?![A-Za-z0-9_-])/g;

/**
 * The accumulated Codex context replays earlier turns, including the broker handles those turns
 * held. A model that copies one binds to a finished turn and burns the round trip. The handle for
 * the current turn is supplied by the contract text, never by the replayed context.
 */
export function withoutRetiredTurnHandles(contextJson: string): string {
  // Match decoded string values: in serialized JSON a newline's `n` is a word character
  // immediately before the handle. Leave structural keys and native tool-call IDs intact.
  return JSON.stringify(JSON.parse(contextJson, (_key, value: unknown) => typeof value === "string"
    ? value.replace(RETIRED_TURN_HANDLE, (_handle, kind: string) => `[retired ${kind} handle]`)
    : value));
}

export function plainMessageText(message: CodexMessage): string | undefined {
  if (message.role === "assistant" || message.role === "agentMessage" || message.role === "toolResult") return undefined;
  if (typeof message.content === "string") return message.content;
  if (message.content.some(part => part.type !== "text")) return undefined;
  return message.content.map(part => part.type === "text" ? part.text : "").join("\n");
}

export function startsWithControlBlock(message: CodexMessage, tag: string): boolean {
  return message.role === "developer" && plainMessageText(message)?.trimStart().startsWith(tag) === true;
}

/**
 * Codex appends a complete replacement developer contract whenever the user changes models. On a
 * later switch the earlier model-switch contract and its adjacent skill catalog are obsolete, but
 * both remain in the Responses history. Replaying every obsolete copy can exceed ChatGPT's composer
 * character ceiling even while the actual model token count is comfortably inside its window.
 *
 * Keep the newest contract verbatim and remove only older Codex-generated replacement contracts.
 * Human messages, assistant history, tool results, and unrelated developer instructions are never
 * touched.
 */
export function withoutSupersededModelSwitchContracts(messages: readonly CodexMessage[]): CodexMessage[] {
  const switchIndices = messages.flatMap((message, index) =>
    startsWithControlBlock(message, "<model_switch>") ? [index] : []
  );
  if (switchIndices.length < 2) return [...messages];

  const newestSwitchIndex = switchIndices.at(-1)!;
  const dropped = new Set<number>();
  for (const index of switchIndices.slice(0, -1)) {
    dropped.add(index);
    const skillCatalogIndex = index + 1;
    if (
      skillCatalogIndex < newestSwitchIndex
      && startsWithControlBlock(messages[skillCatalogIndex]!, "<skills_instructions>")
    ) {
      dropped.add(skillCatalogIndex);
    }
  }
  return messages.filter((_message, index) => !dropped.has(index));
}

export const HISTORICAL_PARALYSIS_PATTERNS: readonly RegExp[] = [
  /sesi[oó]n (?:local )?(?:de ejecuci[oó]n )?(?:sigue )?terminada/i,
  /incluso `?pwd`? falla/i,
  /el entorno local qued[oó] inaccesible/i,
  /la sesi[oó]n local de ejecuci[oó]n termin[oó]/i,
  /Codex Native claim failed and its broker activity could not be retired/i,
  /el broker volvi[oó] a fallar antes de ejecutar/i,
  /el runner\/plugin de Codex se reconecte o reinicie/i,
  /la lectura directa del archivo no est[aá] expuesta por el harness activo/i,
  /local (?:Codex )?session (?:is|remains) terminated/i,
  /even `?pwd`? fails/i,
  /local environment became inaccessible/i,
  /execution session ended before/i,
  /local computer (?:bridge|runner) (?:is|remains) disconnected/i,
  /(?:conector\s+)?Codex Native devolvi[oó]\s+(?:expl[ií]citamente\s+)?`?Session terminated`?/i,
  /`?Session terminated`?\s+(?:tanto al intentar|al consultar|al ejecutar|en el workspace)/i,
  /(?:al intentar ejecutar en el workspace como al consultar su inventario)/i,
  /conector Codex Native devolvi[oó]/i,
  /`?Session terminated`?/i,
];

export function hasParalysisClaim(text: string): boolean {
  return HISTORICAL_PARALYSIS_PATTERNS.some(pattern => pattern.test(text));
}

export function sanitizeParalysisProse(text: string): string {
  if (!hasParalysisClaim(text)) return text;

  const paragraphs = text.split(/\n{2,}/);
  const retained: string[] = [];

  for (const para of paragraphs) {
    if (hasParalysisClaim(para)) {
      if (para.includes("```")) {
        const lines = para.split("\n");
        let inFence = false;
        const cleanLines = lines.filter(line => {
          if (line.trim().startsWith("```")) inFence = !inFence;
          if (inFence) return true;
          return !hasParalysisClaim(line);
        });
        if (cleanLines.length > 0) retained.push(cleanLines.join("\n"));
      } else {
        const sentences = para.split(/(?<=[.?!])\s+/);
        const cleanSentences = sentences.filter(s => !hasParalysisClaim(s));
        if (cleanSentences.length > 0) {
          retained.push(cleanSentences.join(" "));
        }
      }
    } else {
      retained.push(para);
    }
  }

  const result = retained.join("\n\n").trim();
  if (result.length === 0) {
    return "[Historical assistant response omitted: prior turn ended without local workspace mutations.]";
  }
  return result;
}

export function sanitizeHistoricalParalysisClaims(
  messages: readonly CodexMessage[],
): CodexMessage[] {
  return messages.map(message => {
    if (message.role !== "assistant") return message;
    let changed = false;
    const newContent = message.content.map(part => {
      if (part.type !== "text" || !hasParalysisClaim(part.text)) return part;
      changed = true;
      return { ...part, text: sanitizeParalysisProse(part.text) };
    });
    return changed ? { ...message, content: newContent } : message;
  });
}
