import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SteamError } from "./errors.js";

const exec = promisify(execFile);

/**
 * The running client is `.../Steam.AppBundle/Steam/Contents/MacOS/steam_osx` —
 * note AppBundle, not the /Applications/Steam.app launcher stub.
 *
 * Matching argv on "steam_osx" alone is not enough: the CEF helper carries
 * `-steampath=.../steam_osx` in its own command line, so it matches too. We
 * therefore keep only processes whose executable (argv[0]) is steam_osx.
 */
const STEAM_PROCESS_PATTERN = "steam_osx";
const WEBHELPER_PATTERN = "Steam Helper.app";

async function pgrep(pattern: string): Promise<{ pid: number; command: string }[]> {
  try {
    const { stdout } = await exec("pgrep", ["-fl", pattern], { timeout: 5000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        return {
          pid: Number(line.slice(0, space)),
          command: line.slice(space + 1),
        };
      })
      .filter((p) => Number.isInteger(p.pid));
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

/**
 * Processes whose executable really is steam_osx.
 *
 * We match on `ps comm=` (the executable path, no arguments) rather than on
 * argv: the Steam directory contains a space ("Application Support"), so argv
 * cannot be split reliably, and the CEF helper mentions steam_osx in its own
 * arguments anyway.
 */
async function steamClientProcesses(): Promise<{ pid: number; command: string }[]> {
  let stdout: string;
  try {
    const result = await exec("ps", ["-axo", "pid=,comm="], { timeout: 5000, maxBuffer: 8 << 20 });
    stdout = result.stdout;
  } catch (e) {
    stdout = (e as { stdout?: string }).stdout ?? "";
  }

  const procs: { pid: number; command: string }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.endsWith(`/${STEAM_PROCESS_PATTERN}`)) continue;
    const space = trimmed.indexOf(" ");
    const pid = Number(trimmed.slice(0, space));
    if (Number.isInteger(pid)) procs.push({ pid, command: trimmed.slice(space + 1) });
  }
  return procs;
}

export async function isSteamRunning(): Promise<boolean> {
  return (await steamClientProcesses()).length > 0;
}

export async function steamPid(): Promise<number | null> {
  return (await steamClientProcesses())[0]?.pid ?? null;
}

/**
 * Best-effort detection of a running game. Steam launches games out of
 * steamapps/common, so a process whose path contains it is almost certainly a
 * game. Used to refuse a restart that would kill a live session.
 */
export async function runningGames(): Promise<{ pid: number; command: string }[]> {
  const procs = await pgrep("steamapps/common");
  return procs.map((p) => ({
    pid: p.pid,
    // Report just the game directory, not the whole argv.
    command: /steamapps\/common\/([^/]+)/.exec(p.command)?.[1] ?? p.command.slice(0, 120),
  }));
}

/**
 * Asks Steam to quit via AppleScript and waits for the process to disappear.
 *
 * We never signal the process. Steam writes localconfig.vdf and the cloud
 * storage files (which hold every collection) on exit; killing it mid-write is
 * precisely how those files get corrupted. If it will not exit, we say so and
 * stop rather than escalating.
 */
export async function quitSteam(timeoutMs = 45_000): Promise<{ quitMs: number }> {
  const started = Date.now();

  if (!(await isSteamRunning())) return { quitMs: 0 };

  try {
    await exec("osascript", ["-e", 'tell application "Steam" to quit'], { timeout: 15_000 });
  } catch (e) {
    // Steam may already be shutting down, or may not have registered with
    // AppleScript. Fall through to polling before deciding it failed.
    void e;
  }

  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    if (!(await isSteamRunning())) {
      // The web helper can outlive the main process briefly; give it a moment
      // so a relaunch does not race a half-dead CEF stack.
      await waitForWebhelperExit(8000);
      await sleep(1500);
      return { quitMs: Date.now() - started };
    }
  }

  throw new SteamError(
    "UNSUPPORTED",
    `Steam did not exit within ${Math.round(timeoutMs / 1000)}s. It may be finishing a download or a cloud sync.`,
    {
      hint: "Quit Steam manually and retry. This server will not force-kill it, because Steam writes your collections on exit.",
    },
  );
}

async function waitForWebhelperExit(timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await pgrep(WEBHELPER_PATTERN)).length === 0) return;
    await sleep(400);
  }
}

/**
 * Launches Steam with CEF debugging enabled.
 *
 * Always via `open`, never by exec'ing steam_osx directly: that binary is a
 * launcher stub, and bypassing LaunchServices skips the bootstrap/update
 * handshake.
 */
export async function launchSteam(port: number): Promise<{ args: string[] }> {
  const steamArgs = ["-cef-enable-debugging"];
  // 8080 is the built-in default; only pass the override when it differs.
  if (port !== 8080) steamArgs.push("-devtools-port", String(port));

  await exec("open", ["-a", "Steam", "--args", ...steamArgs], { timeout: 20_000 });
  return { args: steamArgs };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
