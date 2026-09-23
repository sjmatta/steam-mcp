import { describe, expect, it } from "vitest";
import {
  auditPageFunction,
  buildExpression,
  interpretEvalResult,
} from "../../src/cdp/expression.js";
import * as readPrograms from "../../src/cdp/programs/read.js";
import * as writePrograms from "../../src/cdp/programs/write.js";

/** Evaluates a built expression the way Steam's page would. */
async function evaluate(fnSource: string, arg: unknown): Promise<unknown> {
  return await (0, eval)(buildExpression(fnSource, arg));
}

describe("buildExpression", () => {
  it("passes the argument through and returns an ok envelope", async () => {
    const result = await evaluate("(a) => a.x + 1", { x: 41 });
    expect(result).toEqual({ ok: true, v: 42 });
  });

  it("awaits an async program", async () => {
    const result = await evaluate("async (a) => a * 2", 21);
    expect(result).toEqual({ ok: true, v: 42 });
  });

  it("turns a thrown page error into data rather than an exception", async () => {
    const result = (await evaluate(
      "() => { throw new Error('STORES_NOT_READY'); }",
      undefined,
    )) as {
      ok: boolean;
      e: string;
      s: string;
    };
    expect(result.ok).toBe(false);
    expect(result.e).toBe("STORES_NOT_READY");
    expect(result.s).toContain("Error");
  });

  it("handles a rejected promise the same way", async () => {
    const result = (await evaluate("async () => { throw new Error('nope'); }", undefined)) as {
      ok: boolean;
      e: string;
    };
    expect(result).toMatchObject({ ok: false, e: "nope" });
  });

  it("survives a thrown non-Error value", async () => {
    const result = (await evaluate("() => { throw 'plain string'; }", undefined)) as { e: string };
    expect(result.e).toBe("plain string");
  });

  /**
   * esbuild (and therefore tsx) wraps functions as __name(fn, "name"). That
   * identifier does not exist in Steam's page, so without the shim the same
   * code works when built with tsc and fails in dev.
   */
  it("defines a __name shim so esbuild-wrapped functions still run", async () => {
    const result = await evaluate('__name((a) => a + 1, "wrapped")', 1);
    expect(result).toEqual({ ok: true, v: 2 });
  });

  it("serialises undefined arguments without producing invalid syntax", async () => {
    expect(buildExpression("() => 1", undefined)).toContain("(undefined)");
    await expect(evaluate("() => 1", undefined)).resolves.toEqual({ ok: true, v: 1 });
  });

  it("escapes strings that would otherwise break out of the expression", async () => {
    const nasty = `"); alert('pwned'); //`;
    const result = await evaluate("(a) => a.value", { value: nasty });
    expect(result).toEqual({ ok: true, v: nasty });
  });
});

describe("interpretEvalResult", () => {
  it("unwraps a successful payload", () => {
    expect(interpretEvalResult({ result: { value: { ok: true, v: [1, 2] } } }, "x")).toEqual([
      1, 2,
    ]);
  });

  it("raises the page's own error message", () => {
    expect(() =>
      interpretEvalResult({ result: { value: { ok: false, e: "DYNAMIC_COLLECTION" } } }, "op"),
    ).toThrow(/DYNAMIC_COLLECTION/);
  });

  it("raises a CDP-level exception with its description", () => {
    expect(() =>
      interpretEvalResult(
        { exceptionDetails: { exception: { description: "ReferenceError: x" } } },
        "op",
      ),
    ).toThrow(/ReferenceError: x/);
  });

  it("falls back to exception text when there is no description", () => {
    expect(() => interpretEvalResult({ exceptionDetails: { text: "Uncaught" } }, "op")).toThrow(
      /Uncaught/,
    );
  });

  it("rejects a malformed or missing payload", () => {
    expect(() => interpretEvalResult({}, "op")).toThrow(/unexpected payload/);
    expect(() => interpretEvalResult({ result: { value: undefined } }, "op")).toThrow(
      /unexpected payload/,
    );
    expect(() =>
      interpretEvalResult({ result: { value: { notOk: true } as never } }, "op"),
    ).toThrow(/unexpected payload/);
  });

  it("preserves a false-y but valid payload value", () => {
    expect(interpretEvalResult({ result: { value: { ok: true, v: false } } }, "x")).toBe(false);
    expect(interpretEvalResult({ result: { value: { ok: true, v: 0 } } }, "x")).toBe(0);
  });
});

describe("auditPageFunction", () => {
  const programs = {
    ...readPrograms,
    ...writePrograms,
  } as Record<string, unknown>;

  const pageFns = Object.entries(programs).filter(([, v]) => typeof v === "function");

  it("finds every exported page program", () => {
    expect(pageFns.length).toBeGreaterThanOrEqual(8);
  });

  it.each(pageFns)("%s ships without helpers or captured module state", (_name, fn) => {
    const audit = auditPageFunction(fn);
    expect(audit.problems).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it("rejects a function carrying a TypeScript downlevel helper", () => {
    const bad = function () {
      return "__awaiter(this, void 0)";
    };
    expect(auditPageFunction(bad).ok).toBe(false);
    expect(auditPageFunction(bad).problems[0]).toMatch(/__awaiter/);
  });

  it("rejects a function that captures a module-scoped identifier", () => {
    const bad = () => SteamError;
    expect(auditPageFunction(bad).problems[0]).toMatch(/captures module-scoped/);
  });

  it("rejects a method shorthand, whose source is not standalone-callable", () => {
    const holder = {
      notStandalone() {
        return 1;
      },
    };
    expect(auditPageFunction(holder.notStandalone).problems).toContain(
      "not a standalone-callable function expression",
    );
  });

  it("rejects a non-function", () => {
    expect(auditPageFunction("nope").ok).toBe(false);
    expect(auditPageFunction(undefined).problems).toEqual(["not a function"]);
  });
});

// Referenced only so the closure-capture test above has something real to close
// over; never called.
declare const SteamError: unknown;
