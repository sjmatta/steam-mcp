# Repository Guidelines

## Project Structure & Module Organization

`src/index.ts` starts the stdio MCP server; `src/tools/` registers its tools. Steam data readers live in `src/local/` and `src/web/`; `src/cdp/` handles the live client's debugger. In-page functions belong in `src/cdp/programs/`. Unit tests are in `test/unit/`, live-client tests in `test/integration/`, and fakes and samples in `test/helpers/` and `test/fixtures/`. Build output goes to `dist/`.

## Build, Test, and Development Commands

Use Node 22.22.1 or newer and `npm ci` to install dependencies. `npm run dev` starts the server from TypeScript; `npm run build` compiles it to `dist/`. Run `npm run check` before proposing changes: it checks formatting, lint, types, dependencies, and unit tests. `npm run smoke` verifies the built server's stdio MCP handshake. `npm run test:coverage` reports V8 coverage.

## Coding Style & Naming Conventions

Use two spaces, LF line endings, semicolons, and double quotes; Prettier enforces a 100-character line width. Run `npm run format` and `npm run lint` after edits. Keep TypeScript strict and use type-only imports where appropriate. Source files use lowercase, descriptive names such as `steam-process.ts`; tests use matching `*.test.ts` names. Keep stdout reserved for JSON-RPC; send diagnostics to stderr. In-page programs must be self-contained, use no value imports, and avoid compiler helpers because Steam runs their serialized function bodies.

## Testing Guidelines

Vitest runs `test/unit/**/*.test.ts` with `npm test`; these tests must use fixtures and fakes, never the real Steam install, network, or user cache. Add regression tests for changed behavior, especially collection writes, dry runs, and CDP serialization. There is no enforced coverage percentage; review `npm run test:coverage` for gaps. Real-client tests run only when explicitly enabled: `STEAM_MCP_E2E=1 npm run test:e2e`. The write suite additionally needs `STEAM_MCP_E2E_WRITES=1` and changes real Steam state.

## Commit & Pull Request Guidelines

Use imperative commit subjects and explain nontrivial decisions in the body. Open a PR for every `main` change; CI, CodeQL, and dependency review must pass. Rebase merge; GitHub deletes the branch afterward. In the PR, describe Steam safety, commands run, and any linked issue. Include live-client evidence for changes that depend on Steam's CEF behavior. Live integration tests remain local.

## Security & Configuration

Use `.env.example` as the configuration reference and keep API keys out of commits. Writes require `STEAM_MCP_ALLOW_WRITES=1`; preserve strict tool schemas, `dry_run` behavior, and verification after mutations. Do not edit Steam Cloud collection files directly or bypass the CDP evaluation queue.
