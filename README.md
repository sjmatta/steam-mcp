# steam-mcp

<img src="assets/logo.png" alt="A cheerful game library mascot holding three colorful fantasy game cards" width="180" />

[![CI](https://github.com/sjmatta/steam-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sjmatta/steam-mcp/actions/workflows/ci.yml)

A local MCP server for the Steam desktop client on macOS: browse and filter your library, and
**read and write library collections** — the thing Steam exposes no web API for.

Collections live only inside the running Steam client and in Steam Cloud. This server reaches them
by driving Steam's own Chromium debugger (`SharedJSContext`), where the library UI keeps
`collectionStore`, `appStore` and `SteamClient`.

> **Steam terms and account risk:** This is an unofficial project that uses undocumented Steam
> client internals through the CEF debugger. The [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/)
> contains restrictions on reverse engineering and tampering. It is unclear whether this tool's
> use of the debugger is permitted under Valve's terms. Review the current terms and decide whether
> to use it with your account; Valve has not endorsed this project.

## Requirements

- macOS and Node 22.22.1+ (Node 24 recommended; see `.nvmrc`)
- Steam installed and signed in
- For collection writes: Steam running with CEF debugging enabled (the `steam_restart` tool does this)

## Set up

From a fresh clone, install the locked dependencies, check the project, and build the server:

```bash
nvm use # if you use nvm; otherwise install Node 22.22.1+
npm ci
npm run check
npm run build
npm run smoke
```

Register with Claude Code from the repository root. This starts in read-only mode:

```bash
claude mcp add steam -- node "$(pwd)/dist/index.js"
```

Restart your MCP client, then call `steam_status` to see which data sources are available. Local
library reads work without an API key. To use the Steam Web API while Steam is closed, configure
`STEAM_API_KEY` in the MCP client's environment. To opt into collection writes, register the server
with `-e STEAM_MCP_ALLOW_WRITES=1` and enable CEF debugging through `steam_restart`. For example,
remove the read-only registration and add it again with your chosen settings:

```bash
claude mcp remove steam
claude mcp add steam -e STEAM_MCP_ALLOW_WRITES=1 -- node "$(pwd)/dist/index.js"
```

The `.env.example` file lists available variables; copying it to `.env` does not load it
automatically. Pass values through your MCP client or process environment. Keep API keys out of Git.

## Configuration

| Variable                 | Default              | Meaning                                                                                                                                                            |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STEAM_MCP_ALLOW_WRITES` | unset (off)          | Master switch for every mutation. Without it, writes return `WRITES_DISABLED`.                                                                                     |
| `STEAM_DEBUG_PORT`       | `8080,8081`          | Comma-separated ports to probe. The first is what `steam_restart` asks Steam to bind.                                                                              |
| `STEAM_API_KEY`          | unset                | Steam Web API key ([get one](https://steamcommunity.com/dev/apikey); any domain works locally). Enables the full owned library and wishlist while Steam is closed. |
| `STEAM_ACCOUNT_ID`       | auto                 | Override account detection (the `userdata/<id>` directory name).                                                                                                   |
| `STEAM_MCP_CACHE_DIR`    | `~/.cache/steam-mcp` | Cache and collection backups.                                                                                                                                      |

### The debug port

Steam's debugger defaults to `127.0.0.1:8080`. If something else already holds that port, Steam
binds nothing at all and debugging silently fails.

If port 8080 is occupied, set `STEAM_DEBUG_PORT=8081` (or another free port) in the MCP client's
environment. The server probes `8080,8081` by default, but `steam_restart` asks Steam to bind the
first configured port.

`steam_status` names whatever is squatting the port, and `steam_restart` refuses _before_ quitting
Steam if the target port is occupied, so a failed restart never leaves you with Steam closed.

## Tools

### Status and lifecycle

- **`steam_status`** — client state, debugger reachability, available sources, per-capability
  availability with reasons. Never throws; call it first when something is unavailable.
- **`steam_restart`** — quit Steam and relaunch it with debugging, then wait for the library UI.
  Requires `confirm: true`, and refuses if a game is running unless `allow_interrupt_game: true`.

### Library

- **`steam_library_list`** — filter by installed/played/hidden/favorite/collection/tag/kind,
  playtime, last played, size, review score. Sorted, paginated, projected.
- **`steam_library_search`** — fuzzy name search; use it to turn names into appids.
- **`steam_game_details`** — one game across all sources, plus store metadata and review score.
- **`steam_tags_list`**, **`steam_recently_played`**, **`steam_wishlist`**

### Collections

- **`steam_collections_list`**, **`steam_collection_get`**
- **`steam_collection_create`** — resolve-or-reuse by name (see Safety)
- **`steam_collection_add_games`**, **`steam_collection_remove_games`**,
  **`steam_collection_replace_games`**
- **`steam_collection_rename`**, **`steam_collection_delete`**
- **`steam_set_favorite`**, **`steam_set_hidden`**

### Installs and cache

- **`steam_install_game`**, **`steam_uninstall_game`** — these open Steam's wizard. There is no
  silent install API; a dialog must be clicked through by hand.
- **`steam_cache_refresh`**, **`steam_cache_clear`**, **`steam_cache_status`**

## How data is sourced

|                   | Steam running               | Steam closed                                  |
| ----------------- | --------------------------- | --------------------------------------------- |
| Library           | live client (authoritative) | Web API (with key) + local files              |
| Collections       | live client                 | `cloud-storage-namespace-1.json`, read-only   |
| Collection writes | ✅                          | ❌ `STEAM_NOT_RUNNING` → call `steam_restart` |

Reads degrade gracefully and set `degraded: true`. Writes never do — they fail with an actionable
error instead.

Installed-state comes from Steam's `local-install` collection, never from `overview.installed`,
which is true for most of a library and actually means "installable".

## Safety

- **Every mutating tool takes `dry_run`.** It reports the exact delta — which appids would be
  added, removed, or lose their membership — and changes nothing. Use it before anything bulk.
- **Unknown arguments are rejected, not ignored.** Tool schemas are strict, so `dryrun`,
  `dry-run`, `appid` (for `appids`), or any other typo fails loudly. Without this the SDK silently
  _strips_ unrecognized keys, which means a mistyped `dry_run` on a destructive tool performs the
  real operation — that is not hypothetical, it deleted a collection during development.
- **Writes are off by default** (`STEAM_MCP_ALLOW_WRITES`).
- **No offline collection writes.** Editing `cloud-storage-namespace-1.json` directly would mean
  reimplementing Valve's `union-collections` merge semantics and two-level version counters, and a
  mistake propagates to Steam Cloud. Writes go through the running client, which does it correctly.
- **Dynamic collections are refused.** Steam recomputes filter-based collections, so manual edits
  are silently reverted — the worst possible failure mode.
- **Create never blind-creates.** Steam _deletes_ a same-named collection when saving a new one, so
  `steam_collection_create` resolves by name first and reuses.
- **Every write is verified by re-reading** the collection in the same evaluation; tools report
  what actually happened, not what was intended.
- **Steam is never force-killed.** It writes collections on exit; `steam_restart` uses AppleScript
  quit and fails loudly rather than escalating.
- **Collection files are backed up** to `~/.cache/steam-mcp/backups/` before the first mutation.
  Note these are Steam's _flushed_ files, which lag the running client — a backup can be missing
  the newest membership changes, so treat it as a recovery aid, not a perfect snapshot.
- **Deleting a collection loses its id.** Recreating produces a new one. Steam Cloud may merge the
  old membership back in on the next sync (`union-collections`), so verify the result.
- Collection ids are opaque and may contain `+` and `*` (`uc-8qBpJj1*+Borh`) — pass them back verbatim.

## Concurrency

Steam's CEF IPC crashes the whole Steam UI ("Collided with existing master response stream") if two
clients evaluate against the same target at once. Every evaluation goes through one promise chain in
`src/cdp/client.ts`; on timeout the socket is destroyed rather than reused, because a timed-out
evaluation is still running in the page and its late reply would collide with the next one.

## Development

```bash
npm run build         # tsc -> dist/
npm run typecheck     # src, tests and configs
npm test              # unit suite (fast, hermetic)
npm run test:coverage
npm run lint          # eslint, type-aware
npm run format        # prettier --write
npm run deps          # knip: unused/undeclared dependencies, dead exports
npm run secrets:check # scan tracked files for likely credentials
npm run smoke         # build, then boot the server and speak MCP to it
npm run check         # everything above except build, coverage and smoke
```

### CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests, and on demand.
Node 22 (the `engines` floor) and 24 on Linux, plus Node 24 on macOS — the only
platform the server supports, so that the day the unit suite stops being
platform-independent is the day CI says so.

Beyond `npm run check`, three steps assert things a type check and unit tests
structurally cannot:

- **The unit suite is hermetic** — re-run with `STEAM_ROOT=/nonexistent`. The
  suite claims no network, no real Steam install, no writes outside a temp
  directory; this is what keeps the claim honest instead of merely stated.
- **The built page programs carry no compiler helpers** — a `__spreadArray` in
  that emit is an unresolvable identifier inside Steam's page. It exists only in
  built output, so nothing else in the pipeline can see it.
- **The server boots and stdout carries only JSON-RPC** (`scripts/smoke-stdio.mjs`).
  Unit tests import modules directly and never start the binary, so a broken
  registration or a stray `stdout` write would pass everything else and fail only
  once a client connected. Verified to fail on an injected stray write.

There is **no deployment job and no integration job**. The integration suite
needs a real, logged-in Steam desktop client to drive over CEF; no hosted runner
has one. Those stay opt-in and local.

Pull requests also run `.github/workflows/dependency-review.yml` to catch newly
introduced vulnerable dependencies. `.github/workflows/codeql.yml` scans
TypeScript and GitHub Actions workflows on pushes, pull requests, and weekly.

### Git hooks

Installed by `npm install` (husky `prepare`).

| Hook         | Runs                                                                                         | Why there                                                     |
| ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pre-commit` | `scripts/check-secrets.mjs --staged`, then `lint-staged` (prettier + eslint on staged files) | Fast enough to not be resented; touches only what you staged. |
| `pre-push`   | `npm run check`                                                                              | The slow, whole-repo gate.                                    |

`pre-push` deliberately does **not** run the integration suite: it drives the real
Steam client and would quit and relaunch it underneath whoever is pushing.

**The secret guard** protects against accidentally committing Steam Web API
keys. Such a key is a bare 32-character uppercase hex
string — nothing about it looks like a credential in a diff, so it has to be
matched by shape. The pre-commit hook scans staged content, while `npm run check`
scans tracked and new files. Findings report file locations without printing possible
credentials. This is a heuristic guard; review changes before publishing.

### Linting

Type-aware `typescript-eslint`, calibrated rather than adopted wholesale. Two
rules earn their place for reasons specific to this server:

- **`no-console` (allowing only `error`)** and a ban on `process.stdout` — stdout
  is the MCP protocol channel, and anything written there corrupts the JSON-RPC
  stream. `src/index.ts` is the one file permitted to name the other console
  methods, because it reassigns them to stderr.
- **`no-restricted-syntax` on `src/cdp/programs/*`** — a value `import` in a page
  program becomes an identifier Steam's page cannot resolve. `auditPageFunction`
  catches this at runtime; the lint rule catches it while you type.

`src/cdp/programs/*` is also the only place where the `no-unsafe-*` rules are
off. Everything those functions touch is Valve's, undeclared, and reshaped by
Steam updates without notice; there is nothing to type against, and inventing
declarations would assert a contract we cannot enforce.

### Tests

Two suites with different contracts.

**Unit** (`test/unit`, ~350 tests, runs in ~2s). Hermetic: no network, no real Steam
install, no writes outside a temp directory. It passes with `STEAM_ROOT=/nonexistent`,
which is the check that keeps it honest. Steam's local files are represented by a
fixture tree in `test/fixtures/steam` that encodes every format quirk we hit — the
duplicate `apps` node in `localconfig.vdf`, tombstoned collections, opaque ids
containing `+` and `*`, a partially-downloaded `.acf`, and librarycache files holding
concatenated JSON documents.

`test/helpers/fake-steam.ts` is a faithful fake of `collectionStore` / `appStore` /
`SteamClient`. Faithful is the point: it reproduces Steam's real semantics, including
that `AddOrRemoveApp` takes raw appids and filters only `undefined`, that
`SaveCollection` deletes a same-named collection, and that `AsDragDropCollection()`
returns null for dynamic collections. A page program that would misbehave against the
real client misbehaves here too.

**Integration** (`test/integration`) drives the real client and is opt-in:

```bash
STEAM_MCP_E2E=1 npm run test:e2e                          # reads + restart guards
STEAM_MCP_E2E=1 STEAM_MCP_E2E_WRITES=1 npm run test:e2e   # + real collection writes
```

Write tests only ever touch collections named `zz-steam-mcp-test-<timestamp>` — unique
per run, so they can never collide with a real collection and trigger Steam's same-name
deletion. They refuse to start if a stray scratch collection exists, clean up in
`afterAll`, and assert that no pre-existing collection changed. The suite establishes
its own Steam state rather than assuming it.

### What the tests are protecting

Each of these is a bug that reached the real library before a test existed for it:

| Guard                                                                | Test                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------- |
| Concurrent evaluations crash the Steam UI                            | `cdp-queue` — 12 parallel calls, peak concurrency must stay 1 |
| A timed-out evaluation must destroy the socket, not release the lock | `cdp-queue` — asserts the destroy callback fires              |
| Creating a collection must reuse a same-named one, never replace it  | `page-programs`, and again live in `live-write`               |
| Flag APIs take raw appids; overviews silently no-op or crash         | `page-programs` — round-trips the flag and reads it back      |
| A dry run must project the delta, not report "no change"             | `page-programs`, `tools`                                      |
| Unknown tool arguments must be rejected, not stripped                | `tools` — `dryrun`, `dry-run`, `appid`, `force`               |
| Writes must fail closed without `STEAM_MCP_ALLOW_WRITES`             | `tools` — every mutating tool                                 |
| `installed` comes from `local-install`, not `overview.installed`     | `merge`, and live agreement with `.acf` in `live-read`        |
| Steam must never be force-killed                                     | `steam-process` — asserts no signal is ever sent              |

Two of these were verified by reintroducing the original bug and confirming the suite
goes red.

**Dry runs cannot substitute for real writes.** The favorite/hidden tools were silently
no-ops for a while precisely because they were only ever exercised with `dry_run`; a
preview never calls the API it is previewing. Anything that flips a bit needs a
round-trip test that reads it back.

Offline assertions check invariants, not exact counts: this runs against a live library
that legitimately changes as games are installed, played, hidden and re-categorised.

### In-page programs

`src/cdp/programs/*.ts` are shipped to Steam via `Function.prototype.toString()`. They
must not reference module scope and must return plain JSON. `tsconfig.json` targets
ES2023 with `importHelpers: false` so `tsc` emits no helpers, and
`auditPageFunction` (exercised over every program in `cdp-expression`) fails the build
if a helper or closure capture ever appears.

Every page program belongs in that directory, including one-liners. The audit sweeps
the module, so a program defined anywhere else is one the guard never sees — which is
exactly what had happened to `collectionMembers`, previously defined in `model.ts`.
