import WebSocket from "ws";
import { SteamError } from "../errors.js";
import { isSteamRunning } from "../steam-process.js";
import { findSharedJsContext, scanPorts, type CdpTarget, type PortProbe } from "./discover.js";
import { EvalQueue } from "./queue.js";
import { buildExpression, interpretEvalResult, type PageResult } from "./expression.js";

const EVAL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 120_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * `ws` hands back a Buffer for a normal frame, but a Buffer[] for a fragmented
 * one and an ArrayBuffer under some options. A bare .toString() would join the
 * fragments with commas or yield "[object ArrayBuffer]" - either way the JSON
 * fails to parse, the reply is dropped as if it were an event, and the pending
 * evaluation hangs until its 30s timeout tears down the socket. Library reads
 * are large enough to fragment, so this is worth getting right.
 */
function decodeFrame(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

export interface CdpConnectionInfo {
  port: number;
  target: CdpTarget;
}

/**
 * Talks to Steam's SharedJSContext over the Chrome DevTools Protocol.
 *
 * The single most important property of this class: **only one
 * Runtime.evaluate may be in flight at a time.** Steam's CEF IPC asserts
 * "Collided with existing master response stream" and takes down the whole
 * Steam UI when two clients drive the same target concurrently. An MCP server
 * can be called concurrently by the model, so every evaluation goes through one
 * promise chain — there is no fast path around it.
 */
class SteamCdpClient {
  private ws: WebSocket | null = null;
  private info: CdpConnectionInfo | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private connecting: Promise<CdpConnectionInfo> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastProbes: PortProbe[] = [];
  // A timed-out evaluation is still running in the page, so the queue tells us
  // to throw the socket away rather than risk a colliding follow-up.
  private readonly queue = new EvalQueue(EVAL_TIMEOUT_MS, (label) => {
    this.destroy(`eval timeout (${label})`);
  });

  /** Port probe results from the most recent connection attempt. */
  get probes(): PortProbe[] {
    return this.lastProbes;
  }

  get connection(): CdpConnectionInfo | null {
    return this.info;
  }

  /**
   * Tears the socket down. Called on close, on error, and — critically — on
   * eval timeout: a timed-out evaluation is still running inside the page and
   * its response will arrive later on a socket we can no longer correlate.
   * Reusing that socket is exactly the collision that crashes Steam, so we
   * throw the connection away instead of releasing the lock onto it.
   */
  private destroy(reason: string): void {
    const socket = this.ws;
    this.ws = null;
    this.info = null;
    this.connecting = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    for (const [, p] of this.pending) {
      p.reject(new SteamError("TARGET_LOST", `Steam debugger connection closed: ${reason}`));
    }
    this.pending.clear();

    if (socket) {
      socket.removeAllListeners();
      try {
        socket.terminate();
      } catch {
        // already gone
      }
    }
  }

  private touchIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.destroy("idle");
    }, IDLE_CLOSE_MS);
    // Do not hold the process open just to keep a debug socket warm.
    this.idleTimer.unref?.();
  }

  private async connect(): Promise<CdpConnectionInfo> {
    if (this.ws?.readyState === WebSocket.OPEN && this.info) return this.info;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      const scan = await scanPorts();
      this.lastProbes = scan.probes;

      if (scan.openPort === null) {
        const occupied = scan.probes.find((p) => p.state === "occupied_by_other");
        const running = await isSteamRunning();

        if (occupied) {
          throw new SteamError(
            "PORT_OCCUPIED",
            `Port ${occupied.port} is held by a non-Steam service${
              occupied.occupant
                ? ` (${occupied.occupant.command}, pid ${occupied.occupant.pid})`
                : ""
            }, so Steam's debugger could not bind it.`,
            {
              details: { probes: scan.probes },
              hint: "Free that port and call steam_restart, or set STEAM_DEBUG_PORT to a free port.",
            },
          );
        }
        if (!running) {
          throw new SteamError("STEAM_NOT_RUNNING", "Steam is not running.", {
            details: { probes: scan.probes },
            hint: "Call steam_restart to launch Steam with debugging enabled.",
          });
        }
        throw new SteamError(
          "DEBUG_PORT_CLOSED",
          "Steam is running but no CEF debugging port is open. It was most likely launched without -cef-enable-debugging.",
          {
            details: { probes: scan.probes },
            hint: "Call steam_restart to relaunch Steam with debugging enabled.",
          },
        );
      }

      const target = await findSharedJsContext(scan.openPort);
      const socket = await this.openSocket(target.webSocketDebuggerUrl);

      this.ws = socket;
      this.info = { port: scan.openPort, target };
      this.touchIdleTimer();
      return this.info;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private openSocket(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      // Steam passes --remote-allow-origins=* to CEF, so no Origin header games
      // are needed here.
      const socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        socket.removeAllListeners();
        socket.terminate();
        reject(new SteamError("TARGET_LOST", "Timed out opening a WebSocket to Steam's debugger."));
      }, CONNECT_TIMEOUT_MS);

      socket.once("open", () => {
        clearTimeout(timer);
        socket.on("message", (data) => {
          this.onMessage(decodeFrame(data));
        });
        socket.on("close", () => {
          this.destroy("socket closed");
        });
        socket.on("error", (err) => {
          this.destroy(err.message);
        });
        resolve(socket);
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        socket.removeAllListeners();
        reject(
          new SteamError("TARGET_LOST", `Could not connect to Steam's debugger: ${err.message}`),
        );
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // an event, not a command reply

    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);

    if (msg.error) {
      pending.reject(new SteamError("EVAL_FAILED", msg.error.message ?? "CDP error"));
    } else {
      pending.resolve(msg.result);
    }
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.ws;
    if (socket?.readyState !== WebSocket.OPEN) {
      throw new SteamError("TARGET_LOST", "Steam debugger connection is not open.");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new SteamError("TARGET_LOST", `Failed to send to Steam: ${err.message}`));
        }
      });
    });
  }

  /**
   * Runs a self-contained function inside Steam's SharedJSContext.
   *
   * `fn` is serialized with Function.prototype.toString(), so it must not
   * capture anything from module scope or rely on TypeScript helpers — see the
   * guard test in scripts/smoke.ts and the tsconfig comment about
   * importHelpers/downlevelIteration.
   */
  async evalInPage<A, R>(fn: (arg: A) => R | Promise<R>, arg: A, label = "eval"): Promise<R> {
    return this.queue.run(label, () => this.runExclusive(fn, arg, label));
  }

  private async runExclusive<A, R>(
    fn: (arg: A) => R | Promise<R>,
    arg: A,
    label: string,
  ): Promise<R> {
    await this.connect();
    this.touchIdleTimer();

    // The in-page try/catch turns a thrown page error into data, so we get a
    // clean message instead of having to dig through CDP exceptionDetails.
    const expression = buildExpression(fn.toString(), arg);

    const raw = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    })) as {
      result?: { value?: PageResult<R> };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };

    return interpretEvalResult<R>(raw, label);
  }

  /** Closes the connection; used by steam_restart before quitting Steam. */
  close(): void {
    this.destroy("explicit close");
  }
}

export const cdp = new SteamCdpClient();
