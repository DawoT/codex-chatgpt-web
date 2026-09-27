import { describe, expect, test } from "bun:test";
import {
  promptCodeUnitEquivalent,
  promptUnitsEquivalent,
  promptTextEquivalent,
  promptEquivalentPrefixLength,
} from "../src/adapters/chatgpt-web/browser/prompt-equivalence";

describe("promptCodeUnitEquivalent", () => {
  test("accepts identical code units", () => {
    expect(promptCodeUnitEquivalent("abc", "abc", 0)).toBe(true);
    expect(promptCodeUnitEquivalent("abc", "abc", 1)).toBe(true);
    expect(promptCodeUnitEquivalent("abc", "abc", 2)).toBe(true);
  });

  test("rejects single space replaced by NBSP", () => {
    // Single space: neither neighbor is a space
    expect(promptCodeUnitEquivalent("a b", "a\u00A0b", 1)).toBe(false);
  });

  test("accepts space replaced by NBSP in multi-space run", () => {
    // Two spaces: index 1 has neighbor at index 2
    expect(promptCodeUnitEquivalent("a  b", "a\u00A0 b", 1)).toBe(true);
    // index 2 has neighbor at index 1
    expect(promptCodeUnitEquivalent("a  b", "a \u00A0b", 2)).toBe(true);
  });

  test("rejects NBSP in expected replaced by space in observed", () => {
    // Intentional NBSP in expected must not be degraded to ordinary space
    expect(promptCodeUnitEquivalent("a\u00A0\u00A0b", "a  b", 1)).toBe(false);
  });

  test("handles boundaries at start and end of string", () => {
    // Space at index 0 with space at index 1
    expect(promptCodeUnitEquivalent("  abc", "\u00A0 abc", 0)).toBe(true);
    // Space at end with space before it
    expect(promptCodeUnitEquivalent("abc  ", "abc \u00A0", 4)).toBe(true);
  });
});

describe("promptUnitsEquivalent", () => {
  test("rejects strings of different lengths", () => {
    expect(promptUnitsEquivalent("hello", "hello world")).toBe(false);
    expect(promptUnitsEquivalent("hello world", "hello")).toBe(false);
  });

  test("accepts identical strings", () => {
    expect(promptUnitsEquivalent("const x = 42;", "const x = 42;")).toBe(true);
  });

  test("accepts contenteditable alternating NBSP in code indentation", () => {
    const expected = "    return true;";
    const observed = " \u00A0 \u00A0return true;";
    expect(promptUnitsEquivalent(expected, observed)).toBe(true);
  });

  test("rejects mutation outside multi-space runs", () => {
    expect(promptUnitsEquivalent("a b c", "a\u00A0b c")).toBe(false);
  });
});

describe("promptTextEquivalent", () => {
  test("normalizes CRLF to LF", () => {
    expect(promptTextEquivalent("line 1\r\nline 2", "line 1\nline 2")).toBe(true);
  });

  test("normalizes trailing spaces at line ends", () => {
    expect(promptTextEquivalent("function foo()   \n  return 1;  ", "function foo()\n  return 1;")).toBe(true);
  });

  test("combines CRLF normalization and multi-space NBSP matching", () => {
    const expected = "class Foo {\r\n    bar()   \r\n}";
    const observed = "class Foo {\n \u00A0 \u00A0bar()\n}";
    expect(promptTextEquivalent(expected, observed)).toBe(true);
  });

  test("fails closed on semantic character differences", () => {
    expect(promptTextEquivalent("let x = 1;", "let y = 1;")).toBe(false);
    expect(promptTextEquivalent("hello world!", "hello world?")).toBe(false);
  });
});

describe("promptEquivalentPrefixLength", () => {
  test("returns full length for equivalent strings", () => {
    expect(promptEquivalentPrefixLength("hello  world", "hello \u00A0world")).toBe(12);
  });

  test("returns offset where divergence occurs", () => {
    const expected = "hello world from codex";
    const observed = "hello earth from codex";
    // "hello " is length 6, divergence at index 6 ('w' vs 'e')
    expect(promptEquivalentPrefixLength(expected, observed)).toBe(6);
  });

  test("handles prefix with NBSP before divergence", () => {
    const expected = "    function alpha()";
    const observed = " \u00A0 \u00A0function beta()";
    // "    function " is 13 chars
    expect(promptEquivalentPrefixLength(expected, observed)).toBe(13);
  });
});
