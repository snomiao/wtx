#!/usr/bin/env node
// The first run after a real install, through rustify's npm launcher, against
// wtx.mjs run directly:
//
//   node rs/parity/launcher.mjs <directory packed by rustify's pack.mjs> <rustify's templates/npm>
//
// (rs/parity/proof.sh packs the package with the binary under test, with the
// pack.mjs beside the parity runner, and runs this on Linux, macOS and
// Windows.) Until its first run, the command that `bun i -g` and `npm i -g`
// give is rustify's launcher, a script that bun runs. Before the launcher's
// first line, bun has read the working directory's .env files into its
// process.env and run the preloads of a bunfig.toml there and of
// BUN_OPTIONS. Launcher v3 starts the binary with the environment the
// command was started with instead of that process.env, so nothing from a
// .env reaches the binary, and the binary hands the run to wtx.mjs, whose
// bun loads the files itself, as when wtx.mjs is the command. What nothing
// can undo is a preload that has already run in the launcher.
//
// So, for each installer (bun and npm) and each scenario, the package is
// installed afresh from a stand-in registry: rustify's registry.mjs, run in
// this process with no upstream, holding the package (published with
// pack.mjs) and its two dependencies (bun-pty and @xterm/headless, packed
// from this checkout's node_modules) and nothing else; nothing reaches the
// real registry. Then, in the scenario's working directory and with the
// same environment each time,
//   - wtx.mjs is run directly: `bun <the installed package>/wtx.mjs`, which
//     is what the published command (its bin is wtx.mjs) is, through its #!
//     line or the package managers' shims;
//   - the installed command, for its first run (the launcher);
//   - and the installed command again: the binary, now in the launcher's
//     place, or the launcher again where it cannot link.
// Each run starts the server on 127.0.0.1 and a free port, creates one
// session whose program writes its environment to a file (env, through
// /bin/sh; on Windows node, writing process.env), waits for that session to
// end, asks GET /sessions and GET /status/me/proj, stops the server, and
// keeps what it printed on stdout and stderr, the HTTP answers, the
// session's environment, the preloads' log, and the files in the working
// directory and in the temp directory. Each must be what wtx.mjs run
// directly gave, but for one thing on a run through the launcher: each
// preload that ran in the launcher (its line says it ran in "wtx", the
// launcher's file, not in "wtx.mjs") has printed its line and written its
// log line once more, before anything else. Which of them ran there is
// printed. A launcher older than v3 fails here at once: it hands the binary
// bun's process.env, .env values and all.
//
// The session's environment is also checked against what wtx.mjs is meant
// to give it: of the .env files only the names on the allow-list (LC_*,
// NODE_*, ...), none of the secrets, and of .env.<NODE_ENV> only the one
// that bun picks by the NODE_ENV the command was started with (none here:
// .env.development, though .env says NODE_ENV=production).
//
// The package managers and every run get an environment made here, not this
// script's: PATH and, on Windows, the system's own variables; a home
// directory of their own (HOME, USERPROFILE, APPDATA, LOCALAPPDATA), and a
// temp directory of their own. npm is the npm on PATH, or PARITY_NPM_CLI, an
// npm-cli.js that this script's runtime runs (for a machine without npm);
// with neither, the npm installs are skipped, and it says so. It prints one
// line per scenario and, at the end, how many passed, and exits 1 unless all
// did.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { REPO } from "./install.mjs";

const [dist, templates] = process.argv.slice(2);
if (!dist || !templates || !fs.existsSync(path.join(dist, "main")) || !fs.existsSync(path.join(templates, "registry.mjs"))) {
  console.error("usage: launcher.mjs <directory packed by rustify's pack.mjs> <rustify's templates/npm>");
  process.exit(2);
}
const isWindows = process.platform === "win32";
const NAME = "@snomiao/wtx";

// The launcher pack.mjs put in the package, and its version.
const version = Number(/rustify launcher v(\d+)/.exec(fs.readFileSync(path.join(dist, "main", "rustify", "wtx"), "utf8").slice(0, 400))?.[1] ?? 0);
if (version < 3) {
  console.log(
    `FAILED: the package's launcher is v${version || "?"} (from ${templates}). Before v3 it starts the binary with bun's process.env, ` +
      "which holds the working directory's .env files, and every terminal session would get them. " +
      "Pack with rustify's templates from launcher v3 on.",
  );
  process.exit(1);
}

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtx-launcher-")));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── the stand-in registry, with the package and its dependencies ────────────

process.env.RUSTIFY_UPSTREAM_REGISTRY = "";
const { startRegistry } = await import(pathToFileURL(path.join(templates, "registry.mjs")).href);
const registry = await startRegistry(path.join(work, "registry"));

/** A gzipped tar of `dir` as `package/...`, as npm packs a package. */
function tarball(dir) {
  const blocks = [];
  const header = (name, size, mode, type) => {
    const block = Buffer.alloc(512);
    let prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf("/", 155);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    block.write(name, 0, 100);
    block.write(mode.toString(8).padStart(7, "0"), 100);
    block.write("0000000", 108);
    block.write("0000000", 116);
    block.write(size.toString(8).padStart(11, "0"), 124);
    block.write("00000000000", 136);
    block.write("        ", 148);
    block.write(type, 156);
    block.write("ustar\u000000", 257);
    block.write(prefix, 345, 155);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, "0") + "\u0000 ", 148);
    return block;
  };
  const walk = (from, as) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(from, entry.name);
      const name = `${as}/${entry.name}`;
      if (entry.isDirectory()) {
        blocks.push(header(`${name}/`, 0, 0o755, "5"));
        walk(file, name);
      } else if (entry.isFile()) {
        const data = fs.readFileSync(file);
        const mode = fs.statSync(file).mode & 0o111 ? 0o755 : 0o644;
        blocks.push(header(name, data.length, mode, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
    }
  };
  walk(dir, "package");
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Publishes `dir`, a package as installed in node_modules, to the stand-in registry. */
async function publishDir(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const data = tarball(dir);
  const file = `${manifest.name.replace(/^@[^/]+\//, "")}-${manifest.version}.tgz`;
  manifest._id = `${manifest.name}@${manifest.version}`;
  manifest.dist = {
    tarball: `${registry.url}/${manifest.name}/-/${file}`,
    shasum: crypto.createHash("sha1").update(data).digest("hex"),
    integrity: `sha512-${crypto.createHash("sha512").update(data).digest("base64")}`,
  };
  const body = { name: manifest.name, versions: { [manifest.version]: manifest }, "dist-tags": { latest: manifest.version }, _attachments: { [file]: { data: data.toString("base64") } } };
  const answer = await fetch(`${registry.url}/${encodeURIComponent(manifest.name)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!answer.ok) throw new Error(`publishing ${manifest._id}: ${answer.status} ${await answer.text()}`);
}

/** Runs a command to its end without blocking this process (the registry answers meanwhile). */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => out.push(chunk));
    const timer = setTimeout(() => child.kill(), 300000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: null, output: `could not be started: ${error.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output: Buffer.concat(out).toString("utf8") });
    });
  });
}

// The environment of the package managers and of every run.
const home = path.join(work, "home");
for (const dir of ["", "AppData/Roaming", "AppData/Local"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
const npmrc = path.join(work, "npmrc");
fs.writeFileSync(npmrc, `//${registry.url.replace(/^http:\/\//, "")}/:_authToken=stand-in\n`);
const SYSTEM = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
function baseEnv(tmp) {
  const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp };
  if (isWindows) {
    for (const name of SYSTEM) if (process.env[name] !== undefined) env[name] = process.env[name];
    Object.assign(env, { USERPROFILE: home, APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"), TEMP: tmp, TMP: tmp });
  }
  return env;
}
const toolEnv = {
  ...baseEnv(path.join(work, "tool-tmp")),
  NPM_CONFIG_USERCONFIG: npmrc,
  NPM_CONFIG_TOKEN: "stand-in",
  NPM_CONFIG_CACHE: path.join(work, "npm-cache"),
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
  BUN_INSTALL_CACHE_DIR: path.join(work, "bun-cache"),
};
fs.mkdirSync(toolEnv.TMPDIR, { recursive: true });

function finish(code) {
  registry.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}

for (const dep of ["bun-pty", "@xterm/headless"]) await publishDir(path.join(REPO, "node_modules", dep));
{
  const published = await run(process.execPath, [path.join(templates, "pack.mjs"), "publish", "--out", dist, "--registry", registry.url], { env: toolEnv, cwd: work });
  if (published.status !== 0) {
    console.log(`FAILED: publishing the package to the stand-in registry:\n${published.output}`);
    finish(1);
  }
}

// ── the installers ──────────────────────────────────────────────────────────

const npmCli = process.env.PARITY_NPM_CLI;
const hasNpm = npmCli ? fs.existsSync(npmCli) : spawnSync("npm", ["--version"], { stdio: "ignore", shell: isWindows }).status === 0;
const npm = (args, options) => (npmCli ? run(process.execPath, [npmCli, ...args], options) : run("npm", args, { ...options, shell: isWindows }));

/** Installs the package afresh into `dir`: how to start the command, and where the package is. */
async function install(installer, dir) {
  if (installer === "bun") {
    const done = await run("bun", ["i", "-g", NAME, "--registry", registry.url], { env: { ...toolEnv, BUN_INSTALL: dir }, cwd: work });
    if (done.status !== 0) throw new Error(`bun i -g failed:\n${done.output}`);
    return { start: [path.join(dir, "bin", isWindows ? "wtx.exe" : "wtx"), []], pkg: path.join(dir, "install", "global", "node_modules", "@snomiao", "wtx") };
  }
  const done = await npm(["i", "-g", "--prefix", dir, NAME, "--registry", registry.url], { env: toolEnv, cwd: work });
  if (done.status !== 0) throw new Error(`npm i -g failed:\n${done.output}`);
  if (isWindows) {
    // As a command prompt starts npm's wtx.cmd.
    const cmd = path.join(dir, "wtx.cmd");
    return { start: [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmd}"`]], verbatim: true, pkg: path.join(dir, "node_modules", "@snomiao", "wtx") };
  }
  return { start: [path.join(dir, "bin", "wtx"), []], pkg: path.join(dir, "lib", "node_modules", "@snomiao", "wtx") };
}

// ── one run of the server ───────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Everything under `dir`, as relative names, sorted. */
function listing(dir) {
  const out = [];
  const walk = (from, as) => {
    let entries = [];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = as ? `${as}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${name}/` : name);
      if (entry.isDirectory()) walk(path.join(from, entry.name), name);
    }
  };
  walk(dir, "");
  return out.sort().join(" ");
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(none)");

fs.writeFileSync(
  path.join(work, "dump-env.cjs"),
  'const fs = require("fs");\nconst out = process.argv[2];\n' +
    'fs.writeFileSync(out + ".part", Object.entries(process.env).map(([k, v]) => k + "=" + v + "\\n").join(""));\n' +
    'fs.renameSync(out + ".part", out);\n',
);

/** Starts the server with `start` in the scenario's directory, drives it, stops it: what was seen. */
async function serve(start, verbatim, scenario, caseDir) {
  const cwd = path.join(caseDir, "cwd");
  const tmp = path.join(caseDir, "tmp");
  const sessionDir = path.join(caseDir, "session");
  const dump = path.join(caseDir, "session-env.txt");
  // Afresh: the scenario's files, and nothing a run before left.
  for (const dir of [cwd, tmp, sessionDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.rmSync(dump, { force: true });
  for (const [name, text] of Object.entries(scenario.files(caseDir))) fs.writeFileSync(path.join(cwd, name), text);
  const port = await freePort();
  const env = { ...baseEnv(tmp), USER_OWN: "mine", LC_USER_OWN: "mine", TERMINAL_WS_PORT: String(port), TERMINAL_WS_HOST: "127.0.0.1", ...scenario.env(caseDir) };
  const server = spawn(start[0], start[1], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, windowsVerbatimArguments: Boolean(verbatim) });
  const logs = { stdout: [], stderr: [] };
  server.stdout.on("data", (chunk) => logs.stdout.push(chunk));
  server.stderr.on("data", (chunk) => logs.stderr.push(chunk));
  let ended = null;
  const end = new Promise((resolve) => {
    server.on("error", (error) => {
      ended = `could not be started: ${error.code}`;
      resolve();
    });
    server.on("close", (code, signal) => {
      ended = ended || (signal ? `signal ${signal}` : `exit ${code}`);
      resolve();
    });
  });
  const text = (name) => Buffer.concat(logs[name]).toString("utf8");
  async function until(test, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !ended) {
      if (await test()) return true;
      await pause(25);
    }
    return test();
  }
  const seen = [];
  const ask = async (method, target, body) => {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}${target}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      seen.push(`${method} ${target}: ${answer.status} ${await answer.text()}`);
    } catch (error) {
      seen.push(`${method} ${target}: no answer (${error.cause?.code || error.message})`);
    }
  };
  if (await until(() => /Terminal WS server listening on port/.test(text("stdout")), 20000)) {
    const program = isWindows ? [process.execPath, path.join(work, "dump-env.cjs"), dump] : ["/bin/sh", "-c", 'env > "$0.part" && mv "$0.part" "$0"', dump];
    await ask("POST", "/sessions/s", { cmd: program, cwd: sessionDir });
    const exited = async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/sessions`)).json();
        return list.some((s) => s.key === "s" && s.exited);
      } catch {
        return false;
      }
    };
    // Its end, and the server's line about it: bun writes its log to a pipe
    // a moment later, and what it has not written yet is lost when it is stopped.
    const over = async () => fs.existsSync(dump) && /\[term\] session s PTY exited\n/.test(text("stdout")) && (await exited());
    if (!(await until(over, 15000))) seen.push("(the session did not end with its environment written)");
    await pause(200);
    await ask("GET", "/sessions");
    await ask("GET", "/status/me/proj");
  } else seen.push("(it did not listen)");
  if (!ended) {
    if (isWindows) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill("SIGTERM");
  }
  await Promise.race([end, pause(15000)]);
  if (!ended) {
    server.kill("SIGKILL");
    await end;
  }
  // What differs from run to run.
  const plain = (s) => s.replaceAll(String(port), "<PORT>").replace(/"(startedAt|lastActivity)":( ?)("[^"]*"|\d+)/g, '"$1":$2<time>');
  return {
    ended: isWindows ? "(stopped by taskkill)" : ended,
    stdout: plain(text("stdout")),
    stderr: plain(text("stderr")),
    http: plain(seen.join("\n")),
    sessionEnv: plain(read(dump)),
    preloads: read(path.join(cwd, "preloads.log")),
    files: listing(cwd),
    tmp: listing(tmp),
  };
}

// ── the scenarios ───────────────────────────────────────────────────────────

/** A preload that says where it ran (the file bun was started with), logs it, and sets two variables. */
const preload = (name, log) =>
  'import fs from "node:fs";\nimport path from "node:path";\n' +
  'const where = path.basename(process.argv[1] ?? "");\n' +
  `console.error(\`preload ${name} ran in \${where}\`);\n` +
  `fs.appendFileSync(${JSON.stringify(log)}, \`${name} \${where}\\n\`);\n` +
  `process.env.LC_FROM_PRELOAD_${name} = "allowed";\nprocess.env.SECRET_FROM_PRELOAD_${name} = "secret";\n`;
const ENV = {
  ".env": "TERMINAL_ACCESS_KEY=key-from-dotenv\nOPENAI_API_KEY=sk-secret-from-dotenv\nNODE_ENV=production\nLC_FROM_DOTENV=allowed-from-dotenv\n",
  ".env.production": "LC_FROM_PRODUCTION=read\nSECRET_FROM_PRODUCTION=secret\nWTX_REPO_BASE=/from/env/production\n",
  ".env.development": "LC_FROM_DEVELOPMENT=read\nSECRET_FROM_DEVELOPMENT=secret\n",
};
const log = (caseDir) => path.join(caseDir, "cwd", "preloads.log");
const bunfig = (caseDir) => ({ "bunfig.toml": 'preload = ["./pre-bunfig.mjs"]\n', "pre-bunfig.mjs": preload("bunfig", log(caseDir)) });
const options = (caseDir) => {
  fs.writeFileSync(path.join(caseDir, "pre-options.mjs"), preload("options", log(caseDir)));
  return { BUN_OPTIONS: `--preload ${path.join(caseDir, "pre-options.mjs")}` };
};
const scenarios = [
  { name: "a .env, .env.production, a bunfig.toml preload and BUN_OPTIONS with a preload", files: (d) => ({ ...ENV, ...bunfig(d) }), env: options },
  { name: "the same where the launcher cannot link (RUSTIFY_NO_LINK=1)", files: (d) => ({ ...ENV, ...bunfig(d) }), env: (d) => ({ ...options(d), RUSTIFY_NO_LINK: "1" }), noLink: true },
  { name: "a .env, .env.production and BUN_OPTIONS with a preload, no bunfig.toml", files: () => ENV, env: options },
  { name: "a .env, .env.production and BUN_OPTIONS without a preload", files: () => ENV, env: () => ({ BUN_OPTIONS: "--smol" }) },
];

/** What wtx.mjs is meant to give a session, whoever started it. */
function sessionProblems(envText) {
  const problems = [];
  const vars = new Map(
    envText
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  for (const name of ["TERMINAL_ACCESS_KEY", "OPENAI_API_KEY", "SECRET_FROM_PRODUCTION", "SECRET_FROM_DEVELOPMENT", "SECRET_FROM_PRELOAD_bunfig", "SECRET_FROM_PRELOAD_options", "WTX_REPO_BASE", "WTX_PACKAGE_ROOT"]) {
    if (vars.has(name)) problems.push(`the session got ${name}`);
  }
  for (const [name, value] of [["LC_FROM_DOTENV", "allowed-from-dotenv"], ["NODE_ENV", "production"], ["LC_FROM_DEVELOPMENT", "read"], ["USER_OWN", "mine"], ["LC_USER_OWN", "mine"]]) {
    if (vars.get(name) !== value) problems.push(`the session's ${name} is ${vars.has(name) ? JSON.stringify(vars.get(name)) : "not set"}, not ${value}`);
  }
  if (vars.has("LC_FROM_PRODUCTION")) problems.push("the session got LC_FROM_PRODUCTION: .env.production was read");
  return problems;
}

/** A run through the launcher, without what the launcher's preloads printed and logged first
 *  (they ran in "wtx", not in "wtx.mjs"). */
function withoutLauncher(seen) {
  const lines = seen.stderr.split("\n");
  let n = 0;
  while (n < lines.length && /^preload \S+ ran in wtx$/.test(lines[n])) n++;
  const logLines = seen.preloads === "(none)" ? [] : seen.preloads.split("\n");
  let m = 0;
  while (m < logLines.length && /^\S+ wtx$/.test(logLines[m])) m++;
  const rest = logLines.slice(m).join("\n");
  return {
    printed: lines.slice(0, n).map((line) => line.replace(/^preload (\S+) ran in wtx$/, "$1")),
    logged: logLines.slice(0, m).map((line) => line.replace(/ wtx$/, "")),
    rest: { ...seen, stderr: lines.slice(n).join("\n"), preloads: rest === "" ? "(none)" : rest },
  };
}

function compare(label, expected, got) {
  const problems = [];
  for (const key of Object.keys(expected)) {
    if (expected[key] !== got[key]) problems.push(`${label}: ${key} differs\n      wtx.mjs: ${JSON.stringify(expected[key])}\n      ${label}: ${JSON.stringify(got[key])}`);
  }
  return problems;
}

const installers = hasNpm ? ["bun", "npm"] : ["bun"];
if (!hasNpm) console.log("  skip    npm: not on this machine (nor PARITY_NPM_CLI)");
let count = 0;
let passed = 0;
for (const installer of installers) {
  for (const [index, scenario] of scenarios.entries()) {
    const caseDir = path.join(work, `${installer}-${index}`);
    fs.mkdirSync(caseDir, { recursive: true });
    const title = `${installer}: ${scenario.name}`;
    const problems = [];
    let measured = "";
    try {
      const installed = await install(installer, path.join(caseDir, "inst"));
      const direct = await serve(["bun", [path.join(installed.pkg, "wtx.mjs")]], false, scenario, caseDir);
      problems.push(...sessionProblems(direct.sessionEnv).map((p) => `wtx.mjs: ${p}`));
      if (direct.preloads !== "(none)" && direct.preloads.split("\n").some((line) => line && !/ wtx\.mjs$/.test(line))) problems.push(`wtx.mjs: a preload ran elsewhere: ${direct.preloads}`);
      for (const run of [1, 2]) {
        const label = run === 1 ? "first run" : scenario.noLink ? "second run (the launcher again)" : "second run (the binary)";
        const seen = await serve(installed.start, installed.verbatim, scenario, caseDir);
        const { printed, logged, rest } = withoutLauncher(seen);
        problems.push(...compare(label, direct, rest));
        if (printed.join() !== logged.join()) problems.push(`${label}: the launcher's preloads printed ${JSON.stringify(printed)} but logged ${JSON.stringify(logged)}`);
        const throughLauncher = run === 1 || scenario.noLink;
        if (!throughLauncher && printed.length) problems.push(`${label}: a preload ran in the launcher`);
        if (run === 1) measured = printed.length ? `; ran once more, in the launcher: ${printed.join(", ")}` : "; no preload ran in the launcher";
      }
    } catch (error) {
      problems.push(error.message);
    }
    count++;
    if (problems.length) {
      console.log(`  FAILED  ${title}\n    ${problems.join("\n    ")}`);
    } else {
      passed++;
      console.log(`  ok      ${title}${measured}`);
    }
  }
}
console.log(`${passed} of ${count} installs: the first run and the second as wtx.mjs run directly, but for the launcher's own run of a preload`);
finish(passed === count ? 0 : 1);
