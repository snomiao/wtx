#!/usr/bin/env node
// The runs of an npm install of wtx that the binary does not start:
//
//   node rs/parity/launcher.mjs <directory packed by rustify's pack.mjs>
//
// (rs/parity/proof.sh packs one with the binary under test and runs this, on
// Linux and macOS.) Until its first run, the command an npm install gives is
// rustify's launcher, a script that bun runs. Before the launcher's first
// line, bun has read the .env files of the working directory into the
// environment the launcher passes on, and run the preloads of a bunfig.toml
// there and of BUN_OPTIONS. wtx.mjs, as published, keeps .env values out of
// its terminal sessions, which get the server's real environment, and runs
// such a preload once; handed back after the launcher, the values would be
// real and reach every session, and the preload would run twice. So the
// binary starts nothing on such a run and says why (rs/src/launcher.rs).
// That is behaviour of the Rust's own, which no run of wtx.mjs can be
// compared with: this checks it against the text it is meant to have.
//
// Each scenario installs the package afresh under a directory of its own, as
// the "v-install" parity cases do (rs/parity/install.mjs: an npm layout,
// <dir>/inst/bin/wtx is the launcher), starts `wtx` there once with
// TERMINAL_WS_PORT=99999 and TERMINAL_WS_HOST=192.0.2.1 (so that a server
// started by mistake ends at Bun.serve), and checks
//   - the exit code (1), stdout (empty), and stderr: what bun's preload
//     printed in the launcher, if anything, and then the binary's message,
//     word for word;
//   - that nothing was started: wtx.mjs writes <temp dir>/koho-term-zshrc
//     before anything else;
//   - the run after it, in the same directory: where the launcher has put
//     the binary in its place, that run is the binary's own and is handed
//     back (RUSTIFY_HANDBACK_TRACE says so, and wtx.mjs then stops at
//     Bun.serve); where it cannot (RUSTIFY_NO_LINK=1), the same refusal.
// WTX_NO_NATIVE=1 hands such a run back all the same.
//
// It prints one line per scenario and, at the end, how many passed, and
// exits 1 unless all did.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install } from "./install.mjs";

const dist = process.argv[2];
if (!dist || !fs.existsSync(path.join(dist, "main"))) {
  console.error("usage: launcher.mjs <directory packed by rustify's pack.mjs>");
  process.exit(2);
}
if (process.platform === "win32") {
  console.log("0 of 0 scenarios: the npm layout here is a POSIX one, not run on Windows");
  process.exit(0);
}

const TRACE = "rustify: handed back to the JavaScript";

/** The binary's message (rs/src/launcher.rs, `message`), for what bun applied. */
function refusal(applied, inPlace, root) {
  let text =
    `wtx: not started: bun ran the npm package's launcher first, and has already applied ${applied.join(", ")}. ` +
    "wtx would pass that on to every terminal session, and its bun would apply it a second time.\n";
  if (inPlace) text += "Run wtx again: it now starts without the launcher.\n";
  else {
    text +=
      "The launcher cannot put the binary in its place here (RUSTIFY_NO_LINK, or a package directory it may not write to), " +
      `so every run goes through it: start wtx with bun instead, bun "${path.join(root, "wtx.mjs")}"\n`;
  }
  return text;
}

const SECRETS = { ".env": "OPENAI_API_KEY=sk-dummy-from-dotenv\nTERMINAL_ACCESS_KEY=dummy-key-from-dotenv\n" };
const scenarios = [
  { name: "a .env with secrets", files: SECRETS, applied: [".env"] },
  { name: "only a .env.local", files: { ".env.local": "X=1\n" }, applied: [".env.local"] },
  { name: "an empty .env.test", files: { ".env.test": "" }, applied: [".env.test"] },
  {
    name: "NODE_ENV=production set in .env, and a .env.production",
    files: { ".env": "NODE_ENV=production\nTERMINAL_WS_HOST=192.0.2.1\n", ".env.production": "TERMINAL_WS_PORT=99998\n" },
    env: { TERMINAL_WS_PORT: null },
    applied: [".env", ".env.production"],
  },
  {
    name: "a bunfig.toml that preloads a script",
    files: { "bunfig.toml": 'preload = ["./pre.mjs"]\n', "pre.mjs": 'console.error("bunfig preload ran");\n' },
    applied: ["bunfig.toml"],
    before: "bunfig preload ran\n",
  },
  {
    name: "BUN_OPTIONS with a preload",
    env: { BUN_OPTIONS: "--preload <DIR>/pre.mjs" },
    outside: { "pre.mjs": 'console.error("BUN_OPTIONS preload ran");\n' },
    applied: ["BUN_OPTIONS"],
    before: "BUN_OPTIONS preload ran\n",
  },
  { name: "a .env and BUN_OPTIONS without a preload", files: { ".env": "X=1\n" }, env: { BUN_OPTIONS: "--smol" }, applied: [".env", "BUN_OPTIONS"] },
  // bun writes lines of its own for these; only how the run ends is checked.
  { name: "a BUN_JSC_ variable", env: { BUN_JSC_logGC: "1" }, applied: ["BUN_JSC_logGC"], noisy: true },
  { name: "a MIMALLOC_ variable", env: { MIMALLOC_VERBOSE: "1" }, applied: ["MIMALLOC_VERBOSE"], noisy: true },
  { name: "the launcher cannot link (RUSTIFY_NO_LINK=1), and a .env", files: SECRETS, env: { RUSTIFY_NO_LINK: "1" }, applied: [".env"], inPlace: false },
  { name: "WTX_NO_NATIVE=1 hands it back all the same", files: SECRETS, env: { WTX_NO_NATIVE: "1" }, handedBack: true },
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), "wtx-launcher-"));
const failures = [];
let passed = 0;

function runWtx(dir, command, env) {
  return spawnSync(command, [], { cwd: path.join(dir, "cwd"), env, encoding: "utf8", timeout: 60000 });
}

for (const [index, scenario] of scenarios.entries()) {
  const dir = path.join(work, String(index));
  for (const sub of ["cwd", "home", "tmp"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  for (const [name, text] of Object.entries(scenario.files || {})) fs.writeFileSync(path.join(dir, "cwd", name), text);
  for (const [name, text] of Object.entries(scenario.outside || {})) fs.writeFileSync(path.join(dir, name), text);
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(dir, "home"),
    TMPDIR: path.join(dir, "tmp"),
    TERMINAL_WS_PORT: "99999",
    TERMINAL_WS_HOST: "192.0.2.1",
  };
  for (const [name, value] of Object.entries(scenario.env || {})) {
    if (value === null) delete env[name];
    else env[name] = value.replaceAll("<DIR>", dir);
  }
  const problems = [];
  const { command, pkg } = install({ prefix: path.join(dir, "inst"), side: "rs", dist });
  const root = fs.realpathSync(pkg);
  const first = runWtx(dir, command, env);
  const started = () => fs.existsSync(path.join(dir, "tmp", "koho-term-zshrc"));
  if (scenario.handedBack) {
    if (first.status !== 1 || !first.stderr.includes("is out of range")) problems.push(`it was not handed back: exit ${first.status}, stderr ${JSON.stringify(first.stderr)}`);
    if (!started()) problems.push("wtx.mjs did not start");
  } else {
    const expected = (scenario.before || "") + refusal(scenario.applied, scenario.inPlace !== false, root);
    if (first.status !== 1) problems.push(`exit ${first.status}, not 1`);
    if (first.stdout !== "") problems.push(`stdout ${JSON.stringify(first.stdout)}`);
    if (scenario.noisy ? !first.stderr.endsWith(expected) : first.stderr !== expected) {
      problems.push(`stderr\n      ${JSON.stringify(first.stderr)}\n    is not\n      ${JSON.stringify(expected)}`);
    }
    if (started()) problems.push("wtx.mjs started all the same (koho-term-zshrc)");
    // The run after it, from the same directory.
    const second = runWtx(dir, command, { ...env, RUSTIFY_HANDBACK_TRACE: "1" });
    if (scenario.inPlace === false) {
      if (second.status !== 1 || !second.stderr.endsWith(expected)) problems.push(`the run after it was not refused the same: exit ${second.status}, stderr ${JSON.stringify(second.stderr)}`);
      if (started()) problems.push("the run after it started wtx.mjs");
    } else {
      if (second.status !== 1 || !second.stderr.includes(`${TRACE}\n`)) problems.push(`the run after it was not handed back: exit ${second.status}, stderr ${JSON.stringify(second.stderr)}`);
      if (!started()) problems.push("the run after it did not start wtx.mjs");
    }
  }
  if (problems.length) {
    failures.push(scenario.name);
    console.log(`  FAILED  ${scenario.name}\n    ${problems.join("\n    ")}`);
  } else {
    passed++;
    console.log(`  ok      ${scenario.name}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
console.log(`${passed} of ${scenarios.length} scenarios of the launcher's run behave as rs/src/launcher.rs says`);
process.exit(failures.length ? 1 : 0);
