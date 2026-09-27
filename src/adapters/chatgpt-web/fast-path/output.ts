import { CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS, type TruncateHeadTailOptions } from "./types";

export function truncateToolOutputText(
  text: string,
  maxChars = CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  options?: TruncateHeadTailOptions,
): string {
  if (text.length <= maxChars) return text;

  let headLimit: number;
  let tailLimit: number;

  if (options?.headChars !== undefined && options?.tailChars !== undefined) {
    headLimit = options.headChars;
    tailLimit = options.tailChars;
  } else {
    const effectiveBudget = Math.max(100, maxChars - 200);
    headLimit = Math.floor(effectiveBudget * (options?.headRatio ?? 0.35));
    tailLimit = Math.floor(effectiveBudget * (options?.tailRatio ?? 0.60));
  }

  const omitted = Math.max(0, text.length - headLimit - tailLimit);
  const head = text.slice(0, headLimit);
  const tail = text.slice(-tailLimit);
  const headCut = head.lastIndexOf("\n");
  const tailCut = tail.indexOf("\n");
  const cleanHead = headCut > 0 ? head.slice(0, headCut) : head;
  const cleanTail = tailCut >= 0 ? tail.slice(tailCut + 1) : tail;
  return [
    cleanHead,
    `\n\n[... output truncated: ${omitted.toLocaleString("en-US")} characters omitted to prevent context overflow. To inspect more, use grep, head/tail, or redirect output to a file ...]\n`,
    cleanTail,
  ].join("\n");
}

export function preserveHeadTailOutput(
  text: string,
  maxChars = CHATGPT_WEB_MAX_TOOL_OUTPUT_CHARS,
  headChars?: number,
  tailChars?: number,
): string {
  return truncateToolOutputText(text, maxChars, { headChars, tailChars });
}
