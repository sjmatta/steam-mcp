import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "../helpers/http.js";

/** Scripted `lsof` / `ps` output for occupant identification. */
let execResponses: Map<string, { stdout: string; fail?: boolean }>;

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    const key = `${cmd} ${args.join(" ")}`;
    const match = [...execResponses.entries()].find(([k]) => key.includes(k));
    const reply = match?.[1];
    if (!reply) {
      cb(new Error(`unexpected exec: ${key}`), { stdout: "", stderr: "" });
      return;
    }
    if (reply.fail) {
      // lsof is noisy on machines with network mounts: non-zero exit, usable stdout.
      const err = Object.assign(new Error("exit 1"), { stdout: reply.stdout, stderr: "warning" });
      cb(err, { stdout: reply.stdout, stderr: "" });
      return;
    }
    cb(null, { stdout: reply.stdout, stderr: "" });
  },
}));

beforeEach(() => {
  execResponses = new Map();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const CDP_VERSION = { Browser: "Chrome/126.0.6478.183", "Protocol-Version": "1.3" };

describe("probePort", () => {
  it("recognises a real CDP endpoint", async () => {
    stubFetch(() => ({ body: CDP_VERSION }));
    const { probePort } = await import("../../src/cdp/discover.js");
    const probe = await probePort(8080);
    expect(probe).toMatchObject({ port: 8080, state: "open" });
    expect(probe.evidence).toContain("Chrome");
  });

  it("treats a closed port as closed", async () => {
    stubFetch(() => ({ throws: true }));
    const { probePort } = await import("../../src/cdp/discover.js");
    expect(await probePort(8080)).toMatchObject({ state: "closed" });
  });

  /**
   * The failure that actually bites: something non-Steam holds the port, so
   * Steam silently opens no debugger at all. The diagnostic must name it.
   */
  it("identifies a non-CDP service squatting the port", async () => {
    stubFetch(() => ({ status: 404, text: "404 page not found" }));
    execResponses.set("lsof", {
      stdout:
        "COMMAND     PID         USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n" +
        "other-servi 80320 testuser   12u  IPv4 0xabc      0t0  TCP 127.0.0.1:8080 (LISTEN)\n",
    });
    execResponses.set("ps", { stdout: "other-service --listen 127.0.0.1:8080\n" });

    const { probePort } = await import("../../src/cdp/discover.js");
    const probe = await probePort(8080);

    expect(probe.state).toBe("occupied_by_other");
    expect(probe.occupant).toMatchObject({ pid: 80320, command: "other-servi" });
    expect(probe.occupant?.cmdline).toContain("other-service --listen");
    expect(probe.evidence).toContain("404 page not found");
  });

  it("treats JSON without a Browser field as not-CDP", async () => {
    stubFetch(() => ({ body: { hello: "world" } }));
    execResponses.set("lsof", { stdout: "" });
    const { probePort } = await import("../../src/cdp/discover.js");
    expect((await probePort(8080)).state).toBe("occupied_by_other");
  });

  it("still reports occupancy when the occupant cannot be identified", async () => {
    stubFetch(() => ({ status: 200, text: "not json" }));
    execResponses.set("lsof", { stdout: "" });
    const { probePort } = await import("../../src/cdp/discover.js");
    const probe = await probePort(8080);
    expect(probe.state).toBe("occupied_by_other");
    expect(probe.occupant).toBeUndefined();
  });

  it("parses lsof output even when lsof exits non-zero", async () => {
    stubFetch(() => ({ status: 404, text: "nope" }));
    execResponses.set("lsof", {
      fail: true,
      stdout: "COMMAND PID USER\nsomething 4242 me   12u  IPv4 TCP 127.0.0.1:8080 (LISTEN)\n",
    });
    execResponses.set("ps", { stdout: "something --serve\n" });
    const { probePort } = await import("../../src/cdp/discover.js");
    expect((await probePort(8080)).occupant).toMatchObject({ pid: 4242 });
  });
});

describe("scanPorts", () => {
  it("returns the first open port and stops probing", async () => {
    const http = stubFetch((url) =>
      url.includes(":8081") ? { body: CDP_VERSION } : { throws: true },
    );
    vi.stubEnv("STEAM_DEBUG_PORT", "8080,8081,8082");
    vi.resetModules();
    const { scanPorts } = await import("../../src/cdp/discover.js");

    const scan = await scanPorts();
    expect(scan.openPort).toBe(8081);
    expect(scan.probes).toHaveLength(2); // 8082 never probed
    expect(http.countMatching(":8082")).toBe(0);
  });

  it("reports every probe when nothing is open", async () => {
    stubFetch(() => ({ throws: true }));
    vi.stubEnv("STEAM_DEBUG_PORT", "8080,8081");
    vi.resetModules();
    const { scanPorts } = await import("../../src/cdp/discover.js");

    const scan = await scanPorts();
    expect(scan.openPort).toBeNull();
    expect(scan.probes.map((p) => p.state)).toEqual(["closed", "closed"]);
  });
});

describe("findSharedJsContext", () => {
  const target = (over: Record<string, unknown> = {}) => ({
    id: "t1",
    type: "page",
    title: "SharedJSContext",
    url: "https://steamloopback.host/index.html?x=1",
    webSocketDebuggerUrl: "ws://127.0.0.1:8081/devtools/page/t1",
    ...over,
  });

  it("selects the SharedJSContext target", async () => {
    stubFetch(() => ({ body: [target()] }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    expect((await findSharedJsContext(8081)).title).toBe("SharedJSContext");
  });

  /**
   * Several targets share the title "Steam"; only the loopback URL
   * distinguishes the real shared context from a decoy window.
   */
  it("ignores a same-titled target with the wrong URL", async () => {
    stubFetch(() => ({
      body: [
        target({ id: "decoy", title: "Steam", url: "about:blank?createflags=18" }),
        target({ id: "real", title: "Steam" }),
      ],
    }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    expect((await findSharedJsContext(8081)).id).toBe("real");
  });

  it("prefers SharedJSContext over a generically-titled candidate", async () => {
    stubFetch(() => ({
      body: [target({ id: "generic", title: "Steam" }), target({ id: "shared" })],
    }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    expect((await findSharedJsContext(8081)).id).toBe("shared");
  });

  it("skips a candidate with no websocket url", async () => {
    stubFetch(() => ({
      body: [target({ id: "no-ws", webSocketDebuggerUrl: "" }), target({ id: "ok" })],
    }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    expect((await findSharedJsContext(8081)).id).toBe("ok");
  });

  /**
   * /json transiently returns an empty list during Big Picture transitions and
   * just after a game exits. That is retryable, not "Steam is closed".
   */
  it("retries an empty target list before giving up", async () => {
    let attempt = 0;
    stubFetch(() => {
      attempt++;
      return { body: attempt < 3 ? [] : [target()] };
    });
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    expect((await findSharedJsContext(8081, 3, 1)).id).toBe("t1");
    expect(attempt).toBe(3);
  });

  it("reports TARGET_LOST with a retry hint once attempts are exhausted", async () => {
    stubFetch(() => ({ body: [] }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    await expect(findSharedJsContext(8081, 2, 1)).rejects.toMatchObject({
      code: "TARGET_LOST",
      hint: expect.stringContaining("steam_restart"),
    });
  });

  it("distinguishes 'no targets' from 'target not among them'", async () => {
    stubFetch(() => ({ body: [{ id: "x", title: "Other", url: "http://x", type: "page" }] }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    await expect(findSharedJsContext(8081, 1, 1)).rejects.toThrow(/not found among its targets/);
  });

  it("survives a malformed /json response", async () => {
    stubFetch(() => ({ body: { not: "an array" } }));
    const { findSharedJsContext } = await import("../../src/cdp/discover.js");
    await expect(findSharedJsContext(8081, 1, 1)).rejects.toMatchObject({ code: "TARGET_LOST" });
  });
});
