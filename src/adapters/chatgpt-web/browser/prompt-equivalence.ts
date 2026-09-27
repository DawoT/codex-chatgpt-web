import { normalizePromptForComparison } from "./payloads";

/**
 * Chromium's contenteditable replaces runs of spaces with alternating ASCII space and NBSP.
 * Tolerate observing U+00A0 where U+0020 was typed, but only when the expected U+0020 belongs
 * to a multi-space run. Single spaces, tabs, newlines, intentional expected NBSP characters,
 * and every other mutation remain exact and fail closed.
 */
export function promptCodeUnitEquivalent(
  expected: string,
  observed: string,
  index: number,
): boolean {
  const expectedUnit = expected[index];
  const observedUnit = observed[index];

  if (expectedUnit === observedUnit) return true;
  if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;

  return expected[index - 1] === " " || expected[index + 1] === " ";
}

export function promptUnitsEquivalent(
  expected: string,
  observed: string,
): boolean {
  if (expected.length !== observed.length) return false;

  for (let index = 0; index < expected.length; index += 1) {
    if (!promptCodeUnitEquivalent(expected, observed, index)) {
      return false;
    }
  }

  return true;
}

export function promptTextEquivalent(
  expected: string,
  observed: string,
): boolean {
  if (expected === observed) return true;
  if (promptUnitsEquivalent(expected, observed)) return true;

  const normExpected = normalizePromptForComparison(expected);
  const normObserved = normalizePromptForComparison(observed);

  if (normExpected === normObserved) return true;
  return promptUnitsEquivalent(normExpected, normObserved);
}

export function promptEquivalentPrefixLength(
  expected: string,
  observed: string,
): number {
  const normExpected = normalizePromptForComparison(expected);
  const normObserved = normalizePromptForComparison(observed);
  const length = Math.min(normExpected.length, normObserved.length);

  let index = 0;
  while (
    index < length
    && promptCodeUnitEquivalent(normExpected, normObserved, index)
  ) {
    index += 1;
  }

  return index;
}
