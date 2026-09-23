import { describe, expect, it } from "vitest";
import { parseVdf, vdfGet, vdfGetNumber, vdfGetObject, vdfGetString } from "../../src/local/vdf.js";

describe("parseVdf", () => {
  it("parses nested quoted key/value pairs", () => {
    const parsed = parseVdf(`
      "AppState"
      {
        "appid"   "427520"
        "name"    "Factorio"
        "UserConfig"
        {
          "language" "english"
        }
      }
    `);
    expect(vdfGetString(parsed, "AppState", "appid")).toBe("427520");
    expect(vdfGetString(parsed, "AppState", "UserConfig", "language")).toBe("english");
  });

  it("handles escapes inside quoted strings", () => {
    const parsed = parseVdf(`"root" { "name" "Say \\"hi\\"\\tnow\\nbye\\\\end" }`);
    expect(vdfGetString(parsed, "root", "name")).toBe('Say "hi"\tnow\nbye\\end');
  });

  it("keeps the backslash for unknown escape sequences, as Steam does", () => {
    const parsed = parseVdf(`"root" { "p" "C:\\\\Games\\qux" }`);
    expect(vdfGetString(parsed, "root", "p")).toBe("C:\\Games\\qux");
  });

  it("skips // line comments", () => {
    const parsed = parseVdf(`
      // leading comment
      "root"
      {
        // inner comment
        "a" "1"
      }
    `);
    expect(vdfGetString(parsed, "root", "a")).toBe("1");
  });

  it("accepts unquoted tokens", () => {
    const parsed = parseVdf(`root { a 1 b two }`);
    expect(vdfGetString(parsed, "root", "a")).toBe("1");
    expect(vdfGetString(parsed, "root", "b")).toBe("two");
  });

  it("returns what it has for an unterminated string instead of throwing", () => {
    expect(() => parseVdf(`"root" { "a" "unterminated`)).not.toThrow();
  });

  it("does not hang or throw on unbalanced braces", () => {
    expect(() => parseVdf(`"root" { "a" "1"`)).not.toThrow();
    expect(() => parseVdf(`}}}}`)).not.toThrow();
    expect(() => parseVdf(``)).not.toThrow();
  });

  it("strips a UTF-8 BOM", () => {
    const parsed = parseVdf('\uFEFF"root" { "a" "1" }');
    expect(vdfGetString(parsed, "root", "a")).toBe("1");
  });

  it("keeps the last value when sibling keys repeat", () => {
    const parsed = parseVdf(`"root" { "a" "1" "a" "2" }`);
    expect(vdfGetString(parsed, "root", "a")).toBe("2");
  });
});

describe("vdf accessors", () => {
  const doc = parseVdf(`"Root" { "Child" { "Value" "42" "Text" "hi" } }`);

  it("looks up paths case-insensitively", () => {
    // Steam is inconsistent about casing across client versions.
    expect(vdfGetString(doc, "root", "child", "text")).toBe("hi");
    expect(vdfGetString(doc, "ROOT", "CHILD", "TEXT")).toBe("hi");
  });

  it("returns undefined for missing paths rather than throwing", () => {
    expect(vdfGet(doc, "nope")).toBeUndefined();
    expect(vdfGet(doc, "Root", "Child", "Value", "TooDeep")).toBeUndefined();
    expect(vdfGetString(undefined, "anything")).toBeUndefined();
  });

  it("distinguishes objects from strings", () => {
    expect(vdfGetObject(doc, "Root", "Child")).toBeTypeOf("object");
    expect(vdfGetObject(doc, "Root", "Child", "Text")).toBeUndefined();
    expect(vdfGetString(doc, "Root", "Child")).toBeUndefined();
  });

  it("parses numbers and rejects non-numeric values", () => {
    expect(vdfGetNumber(doc, "Root", "Child", "Value")).toBe(42);
    expect(vdfGetNumber(doc, "Root", "Child", "Text")).toBeUndefined();
    expect(vdfGetNumber(doc, "Root", "missing")).toBeUndefined();
  });
});
