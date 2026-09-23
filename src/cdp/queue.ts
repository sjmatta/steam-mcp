import { SteamError } from "../errors.js";

/**
 * Serialises evaluations against a single CDP target.
 *
 * Steam's CEF IPC asserts "Collided with existing master response stream" and
 * takes down the entire Steam UI when two clients drive the same target with
 * overlapping in-flight commands. An MCP server can be called concurrently by
 * the model, so this is a correctness requirement, not a nicety.
 *
 * Two subtleties are load-bearing:
 *
 *  1. The chain absorbs rejections, so one failed evaluation cannot wedge the
 *     queue permanently.
 *  2. On timeout the caller is expected to DESTROY the connection rather than
 *     reuse it. A timed-out evaluation is still running in the page and its
 *     reply will arrive later; letting the next evaluation go out on the same
 *     socket is precisely the collision we are avoiding. The queue signals this
 *     through `onTimeout`.
 */
export class EvalQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  /** Highest concurrent depth observed. Must never exceed 1. */
  private peak = 0;

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly onTimeout: (label: string) => void = () => {},
  ) {}

  /** Diagnostics for tests: the queue is broken if this is ever above 1. */
  get peakConcurrency(): number {
    return this.peak;
  }

  run<T>(label: string, task: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(() => this.execute(label, task));
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async execute<T>(label: string, task: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.onTimeout(label);
        reject(
          new SteamError(
            "EVAL_TIMEOUT",
            `Steam did not answer "${label}" within ${Math.round(this.timeoutMs / 1000)}s; the debugger connection was reset.`,
            {
              hint: "Retry once. If it repeats, Steam's UI process may be wedged — call steam_restart.",
            },
          ),
        );
      }, this.timeoutMs);
      // Never keep the process alive purely for a pending timeout.
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      return await Promise.race([task(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight--;
      void timedOut;
    }
  }
}
