import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ExecCall {
  cmd: string;
  args: string[];
}

let execCalls: ExecCall[];
let responder: (cmd: string, args: string[]) => { stdout?: string; fail?: boolean };

vi.mock("node:child_process", () => ({
  execFile: (
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execCalls.push({ cmd, args });
    const reply = responder(cmd, args);
    if (reply.fail) {
      cb(Object.assign(new Error("exit 1"), { stdout: reply.stdout ?? "" }), {
        stdout: reply.stdout ?? "",
        stderr: "",
      });
      return;
    }
    cb(null, { stdout: reply.stdout ?? "", stderr: "" });
  },
}));

/** Real `ps -axo pid=,comm=` output from a machine running Steam. */
const PS_WITH_STEAM = [
  "  254 /usr/sbin/coreaudiod",
  "21890 /Users/me/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/ipcserver",
  "66580 /Users/me/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/steam_osx",
  "66595 /Users/me/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/Frameworks/Steam Helper.app/Contents/MacOS/Steam Helper",
].join("\n");

const PS_WITHOUT_STEAM = ["  254 /usr/sbin/coreaudiod", "21890 /some/other/process"].join("\n");

beforeEach(() => {
  execCalls = [];
  responder = () => ({ stdout: "" });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isSteamRunning", () => {
  /**
   * The client lives under Steam.AppBundle, not /Applications/Steam.app, and
   * the path contains a space ("Application Support") so argv cannot be split
   * on whitespace. Matching `ps comm=` avoids both traps.
   */
  it("finds the real client process", async () => {
    responder = () => ({ stdout: PS_WITH_STEAM });
    const { isSteamRunning, steamPid } = await import("../../src/steam-process.js");
    expect(await isSteamRunning()).toBe(true);
    expect(await steamPid()).toBe(66580);
  });

  it("does not match the CEF helper, which mentions steam_osx in its arguments", async () => {
    // The helper's argv contains -steampath=.../MacOS/steam_osx, so an argv
    // match would return two processes; comm= returns only the executable.
    responder = () => ({ stdout: PS_WITH_STEAM });
    const { steamPid } = await import("../../src/steam-process.js");
    expect(await steamPid()).toBe(66580);
    expect(execCalls[0]!.args).toEqual(["-axo", "pid=,comm="]);
  });

  it("does not match the always-resident ipcserver", async () => {
    responder = () => ({
      stdout:
        "21890 /Users/me/Library/Application Support/Steam/Steam.AppBundle/Steam/Contents/MacOS/ipcserver",
    });
    const { isSteamRunning } = await import("../../src/steam-process.js");
    expect(await isSteamRunning()).toBe(false);
  });

  it("reports not running when Steam is absent", async () => {
    responder = () => ({ stdout: PS_WITHOUT_STEAM });
    const { isSteamRunning, steamPid } = await import("../../src/steam-process.js");
    expect(await isSteamRunning()).toBe(false);
    expect(await steamPid()).toBeNull();
  });

  it("tolerates ps failing", async () => {
    responder = () => ({ fail: true, stdout: "" });
    const { isSteamRunning } = await import("../../src/steam-process.js");
    expect(await isSteamRunning()).toBe(false);
  });
});

describe("runningGames", () => {
  it("reports the game directory rather than a full command line", async () => {
    responder = (cmd) =>
      cmd === "pgrep"
        ? { stdout: "12345 /Users/me/Library/.../steamapps/common/Portal 2/portal2.app/x\n" }
        : { stdout: "" };
    const { runningGames } = await import("../../src/steam-process.js");
    const games = await runningGames();
    expect(games).toEqual([{ pid: 12345, command: "Portal 2" }]);
  });

  it("returns nothing when no game is running", async () => {
    responder = () => ({ fail: true, stdout: "" }); // pgrep exits 1 on no match
    const { runningGames } = await import("../../src/steam-process.js");
    expect(await runningGames()).toEqual([]);
  });
});

describe("quitSteam", () => {
  it("is a no-op when Steam is not running", async () => {
    responder = () => ({ stdout: PS_WITHOUT_STEAM });
    const { quitSteam } = await import("../../src/steam-process.js");
    expect(await quitSteam()).toEqual({ quitMs: 0 });
    expect(execCalls.some((c) => c.cmd === "osascript")).toBe(false);
  });

  it("asks Steam to quit via AppleScript and waits for it to disappear", async () => {
    let psCalls = 0;
    responder = (cmd) => {
      if (cmd === "ps") {
        psCalls++;
        // Present on the first check, gone afterwards.
        return { stdout: psCalls <= 1 ? PS_WITH_STEAM : PS_WITHOUT_STEAM };
      }
      return { stdout: "" };
    };
    const { quitSteam } = await import("../../src/steam-process.js");
    const result = await quitSteam(10_000);

    expect(result.quitMs).toBeGreaterThanOrEqual(0);
    const osascript = execCalls.find((c) => c.cmd === "osascript");
    expect(osascript?.args.join(" ")).toContain('tell application "Steam" to quit');
  });

  /**
   * Steam writes localconfig.vdf and the cloud-storage files (which hold every
   * collection) on exit. Killing it mid-write is how those get corrupted, so a
   * stubborn client is reported, never signalled.
   */
  it("never signals the process, and fails loudly when Steam will not exit", async () => {
    responder = () => ({ stdout: PS_WITH_STEAM });
    const { quitSteam } = await import("../../src/steam-process.js");

    await expect(quitSteam(1200)).rejects.toThrow(/did not exit within/);
    expect(execCalls.some((c) => c.cmd === "kill" || c.cmd === "pkill")).toBe(false);
  });

  it("explains why it will not force-kill", async () => {
    responder = () => ({ stdout: PS_WITH_STEAM });
    const { quitSteam } = await import("../../src/steam-process.js");
    await expect(quitSteam(1200)).rejects.toMatchObject({
      hint: expect.stringContaining("writes your collections on exit"),
    });
  });
});

describe("launchSteam", () => {
  it("launches through open, never the launcher stub directly", async () => {
    responder = () => ({ stdout: "" });
    const { launchSteam } = await import("../../src/steam-process.js");
    const result = await launchSteam(8080);

    const call = execCalls.find((c) => c.cmd === "open")!;
    expect(call.args).toEqual(["-a", "Steam", "--args", "-cef-enable-debugging"]);
    expect(result.args).toEqual(["-cef-enable-debugging"]);
    expect(execCalls.some((c) => c.cmd.includes("steam_osx"))).toBe(false);
  });

  it("passes -devtools-port only for a non-default port", async () => {
    responder = () => ({ stdout: "" });
    const { launchSteam } = await import("../../src/steam-process.js");

    const result = await launchSteam(8081);
    expect(result.args).toEqual(["-cef-enable-debugging", "-devtools-port", "8081"]);
    expect(execCalls.at(-1)!.args).toContain("8081");
  });
});
