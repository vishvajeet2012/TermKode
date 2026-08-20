import { describe, expect, test } from "bun:test";
import { toSingleLine } from "./clipboard";

// A key is almost never copied cleanly: a web page adds a trailing newline, a
// terminal adds CRLF, and a triple-click takes the surrounding whitespace with
// it. A newline reaching a one-line input either submits the form early or is
// dropped mid-value, so it is removed before the text is inserted.
describe("toSingleLine", () => {
  test("leaves a clean value untouched", () => {
    expect(toSingleLine("sk-ant-api03-abcdef")).toBe("sk-ant-api03-abcdef");
  });

  test("removes the trailing newline the platform tools add", () => {
    expect(toSingleLine("sk-test\n")).toBe("sk-test");
    expect(toSingleLine("sk-test\r\n")).toBe("sk-test");
  });

  test("trims whitespace picked up by a sloppy selection", () => {
    expect(toSingleLine("   sk-test   ")).toBe("sk-test");
  });

  test("collapses a multi-line paste rather than truncating it", () => {
    expect(toSingleLine("line one\r\nline two")).toBe("line one line two");
  });

  test("collapses tabs, which a one-line input would otherwise swallow", () => {
    expect(toSingleLine("a\tb")).toBe("a b");
  });

  test("keeps single spaces inside the value", () => {
    expect(toSingleLine("Bearer abc def")).toBe("Bearer abc def");
  });

  test("returns an empty string for an empty clipboard", () => {
    expect(toSingleLine("")).toBe("");
    expect(toSingleLine("\r\n  \n")).toBe("");
  });
});
