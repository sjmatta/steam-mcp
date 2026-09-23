#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "--staged" && mode !== "--all") {
  console.error("Usage: node scripts/check-secrets.mjs --staged|--all");
  process.exit(2);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "buffer" });
}

const paths = git(
  ...(mode === "--staged"
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
    : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
)
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ["Steam API key shape", /(^|[^A-Za-z0-9])[0-9A-F]{32}(?![A-Za-z0-9])/gm],
  ["GitHub token shape", /gh[pousr]_[A-Za-z0-9_]{30,}/g],
  ["OpenAI key shape", /sk-[A-Za-z0-9_-]{20,}/g],
  [
    "credential assignment",
    /(?:api[_-]?key|secret|password|token)["' ]*[:=][ ]*["']?[A-Za-z0-9/+_-]{16,}/gi,
  ],
];

let findings = 0;
for (const path of paths) {
  let bytes;
  try {
    bytes = mode === "--staged" ? git("show", `:${path}`) : readFileSync(path);
  } catch {
    // A tracked file may have been removed locally but not staged yet.
    try {
      bytes = git("show", `:${path}`);
    } catch {
      console.error(`Could not scan ${path}`);
      process.exit(2);
    }
  }
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  for (const [description, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const line = content.slice(0, match.index).split("\n").length;
      console.error(`${path}:${line}: possible ${description}`);
      findings++;
    }
  }
}

if (findings) {
  console.error(
    `Found ${findings} possible credential(s). Review before committing or publishing.`,
  );
  process.exit(1);
}

console.log(
  `Secret scan passed (${paths.length} ${mode === "--staged" ? "staged" : "tracked and new"} files).`,
);
