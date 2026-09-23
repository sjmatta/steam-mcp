import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { debugPortCandidates } from "../config.js";
import { SteamError } from "../errors.js";

const exec = promisify(execFile);

/**
 * Titles Steam has used for the SharedJSContext target across client versions.
 * Matching on title alone is not enough — several targets are titled "Steam" —
 * so a URL hint is required as well.
 */
const TARGET_TITLES = new Set([
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
]);

const TARGET_URL_HINTS = [
  "https://steamloopback.host/routes/",
  "https://steamloopback.host/index.html",
];

/** Preference when several targets match; earlier is better. */
const TITLE_PRIORITY = [
  "SharedJSContext",
  "Steam Shared Context presented by Valve™",
  "Steam",
  "SP",
];

export interface CdpTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
}

export type PortState = "open" | "closed" | "occupied_by_other";

export interface PortProbe {
  port: number;
  state: PortState;
  /** Present when state is occupied_by_other and we could identify the process. */
  occupant?: { pid: number; command: string; cmdline: string };
  evidence?: string;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identifies whichever process holds a TCP port.
 *
 * lsof is noisy on this machine (Time Machine SMB mounts make it warn on
 * stderr and exit non-zero), so we parse stdout only and tolerate failure.
 */
async function identifyOccupant(
  port: number,
): Promise<{ pid: number; command: string; cmdline: string } | undefined> {
  let stdout: string;
  try {
    const result = await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      timeout: 5000,
    });
    stdout = result.stdout;
  } catch (e) {
    // Non-zero exit still carries usable stdout.
    stdout = (e as { stdout?: string }).stdout ?? "";
  }

  const line = stdout
    .split("\n")
    .slice(1)
    .find((l) => l.trim().length > 0);
  if (!line) return undefined;

  const parts = line.trim().split(/\s+/);
  const command = parts[0] ?? "unknown";
  const pid = Number(parts[1] ?? NaN);
  if (!Number.isInteger(pid)) return undefined;

  let cmdline = command;
  try {
    const ps = await exec("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5000 });
    cmdline = ps.stdout.trim() || command;
  } catch {
    // keep the short name
  }

  return { pid, command, cmdline };
}

/**
 * Probes one port. A CDP endpoint answers /json/version with JSON containing a
 * `Browser` field; anything else answering is a different service squatting the
 * port, which is the failure we most want to name explicitly.
 */
export async function probePort(port: number): Promise<PortProbe> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, 1500);
  } catch {
    return { port, state: "closed" };
  }

  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { Browser?: unknown };
    if (typeof parsed.Browser === "string") {
      return { port, state: "open", evidence: parsed.Browser };
    }
  } catch {
    // fall through to occupied
  }

  const occupant = await identifyOccupant(port);
  const snippet = body.slice(0, 80).replace(/\s+/g, " ").trim();
  return {
    port,
    state: "occupied_by_other",
    ...(occupant ? { occupant } : {}),
    evidence: `GET /json/version returned HTTP ${res.status} with a non-CDP body (${JSON.stringify(snippet)}).`,
  };
}

export interface PortScan {
  probes: PortProbe[];
  openPort: number | null;
}

export async function scanPorts(ports = debugPortCandidates()): Promise<PortScan> {
  const probes: PortProbe[] = [];
  for (const port of ports) {
    const probe = await probePort(port);
    probes.push(probe);
    if (probe.state === "open") return { probes, openPort: port };
  }
  return { probes, openPort: null };
}

function pickTarget(targets: CdpTarget[]): CdpTarget | undefined {
  const matching = targets.filter(
    (t) =>
      TARGET_TITLES.has(t.title) &&
      TARGET_URL_HINTS.some((hint) => t.url.includes(hint)) &&
      typeof t.webSocketDebuggerUrl === "string" &&
      t.webSocketDebuggerUrl.length > 0,
  );
  if (matching.length === 0) return undefined;

  matching.sort((a, b) => {
    const ai = TITLE_PRIORITY.indexOf(a.title);
    const bi = TITLE_PRIORITY.indexOf(b.title);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  return matching[0];
}

/**
 * Finds the SharedJSContext target.
 *
 * /json transiently returns an EMPTY list while Steam moves between Big Picture
 * and desktop mode, and just after a game exits. That is a retryable condition,
 * never "Steam is closed" — so we retry before giving up.
 */
export async function findSharedJsContext(
  port: number,
  attempts = 3,
  delayMs = 700,
): Promise<CdpTarget> {
  let lastCount = -1;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delayMs));

    let targets: CdpTarget[];
    try {
      const res = await fetchWithTimeout(`http://127.0.0.1:${port}/json`, 5000);
      targets = (await res.json()) as CdpTarget[];
    } catch {
      continue;
    }
    if (!Array.isArray(targets)) continue;
    lastCount = targets.length;

    const target = pickTarget(targets);
    if (target) return target;
  }

  throw new SteamError(
    "TARGET_LOST",
    lastCount === 0
      ? "Steam's debugger is reachable but currently lists no targets. This happens while Steam switches between Big Picture and desktop mode, or just after a game exits."
      : "Steam's debugger is reachable but the SharedJSContext target was not found among its targets.",
    {
      details: { port, targetsSeen: lastCount, attempts },
      hint: "Retry in a few seconds. If it persists, call steam_restart.",
    },
  );
}
