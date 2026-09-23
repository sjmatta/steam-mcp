import { describe, expect, it, vi } from "vitest";
import { EvalQueue } from "../../src/cdp/queue.js";
import { isSteamError } from "../../src/errors.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("EvalQueue", () => {
  /**
   * The load-bearing property. Two overlapping Runtime.evaluate calls against
   * one target crash the Steam UI, so this is a correctness test, not a
   * performance one.
   */
  it("never runs two evaluations at once", async () => {
    const queue = new EvalQueue();
    let active = 0;
    let peak = 0;

    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await tick(5);
      active--;
      return "done";
    };

    await Promise.all(Array.from({ length: 12 }, (_, i) => queue.run(`eval-${i}`, task)));

    expect(peak).toBe(1);
    expect(queue.peakConcurrency).toBe(1);
  });

  it("preserves submission order", async () => {
    const queue = new EvalQueue();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        queue.run(`e${n}`, async () => {
          await tick(n === 1 ? 10 : 1); // the first is slowest
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("returns each task's own result to its own caller", async () => {
    const queue = new EvalQueue();
    const results = await Promise.all([
      queue.run("a", async () => "A"),
      queue.run("b", async () => "B"),
      queue.run("c", async () => "C"),
    ]);
    expect(results).toEqual(["A", "B", "C"]);
  });

  it("does not wedge the queue when a task rejects", async () => {
    const queue = new EvalQueue();
    const failed = queue.run("bad", async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(queue.run("good", async () => "ok")).resolves.toBe("ok");
  });

  it("keeps later tasks running after an earlier rejection in the same batch", async () => {
    const queue = new EvalQueue();
    const results = await Promise.allSettled([
      queue.run("a", async () => {
        throw new Error("first fails");
      }),
      queue.run("b", async () => "second succeeds"),
    ]);
    expect(results[0].status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "second succeeds" });
  });

  it("rejects with EVAL_TIMEOUT when a task overruns", async () => {
    const queue = new EvalQueue(20);
    const promise = queue.run("slow", () => new Promise(() => {})); // never settles
    await expect(promise).rejects.toMatchObject({ code: "EVAL_TIMEOUT" });
    await expect(promise).rejects.toThrow(/did not answer "slow"/);
  });

  it("carries an actionable hint on timeout", async () => {
    const queue = new EvalQueue(10);
    try {
      await queue.run("slow", () => new Promise(() => {}));
      expect.unreachable("should have timed out");
    } catch (e) {
      expect(isSteamError(e)).toBe(true);
      if (isSteamError(e)) expect(e.hint).toMatch(/steam_restart/);
    }
  });

  /**
   * On timeout the evaluation is still running in the page and its reply will
   * arrive later. The connection must be destroyed rather than reused, so the
   * queue signals the owner instead of quietly releasing the lock.
   */
  it("signals the owner to destroy the connection on timeout", async () => {
    const onTimeout = vi.fn();
    const queue = new EvalQueue(15, onTimeout);
    await expect(queue.run("hangs", () => new Promise(() => {}))).rejects.toMatchObject({
      code: "EVAL_TIMEOUT",
    });
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(onTimeout).toHaveBeenCalledWith("hangs");
  });

  it("does not fire the timeout for a task that finishes in time", async () => {
    const onTimeout = vi.fn();
    const queue = new EvalQueue(200, onTimeout);
    await expect(queue.run("fast", async () => "quick")).resolves.toBe("quick");
    await tick(250);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("still serialises work queued behind a timed-out task", async () => {
    const queue = new EvalQueue(20);
    const hung = queue.run("hangs", () => new Promise(() => {}));
    const after = queue.run("after", async () => "ran anyway");
    await expect(hung).rejects.toMatchObject({ code: "EVAL_TIMEOUT" });
    await expect(after).resolves.toBe("ran anyway");
    expect(queue.peakConcurrency).toBe(1);
  });
});
