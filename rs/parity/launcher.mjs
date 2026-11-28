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
// command was started with instead of that process.env, as it reads it,
// also when it is empty and when it holds a variable a preload deleted from
// process.env, so nothing from a .env reaches the binary, and the binary
// hands the run to wtx.mjs, whose bun loads the files itself, as when
// wtx.mjs is the command. What nothing can undo is a preload that has
// already run in the launcher.
//
// So, for each installer (bun, npm, and pnpm where there is one) and each
// scenario (below), the package is installed afresh from a stand-in
// registry: rustify's
// registry.mjs, run in this process with no upstream, holding the package
// (published with pack.mjs) and its two dependencies (bun-pty and
// @xterm/headless, packed from this checkout's node_modules) and nothing
// else; nothing reaches the real registry. Then, in the scenario's working
// directory and with the same environment each time,
//   - wtx.mjs is run directly: `bun <the installed package>/wtx.mjs`, which
//     is what the published command (its bin is wtx.mjs) is, through its #!
//     line or the package managers' shims;
//   - the installed command, for its first run (the launcher);
//   - and the installed command again: the binary, now in the launcher's
//     place, or the launcher again where it cannot link. With bun and npm
//     the first run must have put the binary there, but under
//     RUSTIFY_NO_LINK=1 (on Windows: the shim then starts <command>.exe).
// Each run starts the server on 127.0.0.1 and a free port, creates one
// session whose program writes its environment to a file (env, through
// /bin/sh; on Windows node, writing process.env) and stays, waits for the
// file and until the server has been quiet for a moment, asks GET /sessions
// and GET /status/me/proj, stops the server, and keeps what it printed on
// stdout and stderr, the HTTP answers, the session's environment, the
// preloads' log, and the files in the working directory and in the temp
// directory. Each must be what wtx.mjs run
// directly gave, but for one thing on a run through the launcher: each
// preload that ran in the launcher (its line says it ran in "wtx", the
// launcher's file, not in "wtx.mjs") has printed its line and written its
// log line once more, before anything else. Which of them ran there is
// printed. And on Windows, where bun writes what JavaScript sets in
// process.env into the process's own environment too (in capitals), and
// every session gets that under wtx.mjs as well: the variables the
// launcher's preload set reach the binary, since launcher v3 reads that
// environment, and so the session gets them under that spelling, which
// Windows takes for the same variable; it is printed when it happens. A
// launcher older than v3 fails here at once: it hands the binary bun's
// process.env, .env values and all. The first cut of v3 (rustify 25ce88e)
// fails the scenarios of a deleted variable and of an empty environment:
// it took such a read for a wrong one and passed process.env on.
//
// The scenarios: a .env with TERMINAL_ACCESS_KEY, a secret,
// NODE_ENV=production and an allow-listed name, with .env.production and
// .env.development; that with a bunfig.toml preload, with BUN_OPTIONS with
// and without a preload, and with RUSTIFY_NO_LINK=1; a bunfig.toml preload
// and a BUN_OPTIONS one that delete DROP_ME, a variable the command was
// started with, each with and without RUSTIFY_NO_LINK=1; an empty
// environment (env -i, Linux and macOS); a bunfig.toml preload that sets
// NODE_ENV, with a .env that does not; every .env file bun reads here, and
// two it does not, with allow-listed names (GH_TOKEN, GITHUB_TOKEN, EDITOR,
// XDG_*, BUN_*, GIT_*, ...) and secrets in each; BUN_OPTIONS=--env-file; the
// user's own WTX_PACKAGE_ROOT; a preload that sets a long process.title; a
// bunfig.toml preload that deletes process.versions.bun, also with
// RUSTIFY_NO_LINK=1, and a BUN_OPTIONS one; a bunfig.toml preload that puts
// in process.env's place an object that throws when asked `name in
// process.env`. pnpm installs the package in the first scenario, the one with
// RUSTIFY_NO_LINK=1 and the one of every .env file: its command is a shim of
// its own on every system, on Linux and macOS an sh script that runs `bun
// <the package>/rustify/wtx`, as the launcher's #! line says, and on Windows
// a .cmd that runs bun so with .JS taken out of PATHEXT, which the launcher
// does not repoint; wtx.mjs is started there through the same .cmd naming
// wtx.mjs, as pnpm installs the published command.
//
// Where a scenario fails on a fault of rustify's launcher that is known
// (the verifier's, 2026-11-28), its failure says which and what rustify must
// change, from the packed launcher's text or, for pnpm, from what the first
// run left; it still fails. Known: a launcher that reads nothing when a
// preload has deleted process.versions.bun and then passes bun's
// process.env on (rustify's templates at cc50aec, a629a0a and 23f6df4); one
// that asks `name in process.env` inside the try that guards the read
// (cc50aec and a629a0a); and one that, on Linux and macOS, puts the binary
// in the place of the file pnpm's shim hands to bun, which bun cannot run
// (all three). rustify d9f603c (#57), main and releases/v1 since
// 2026-11-28, has none of them: it reads the environment whatever
// process.versions says, and on Linux and macOS links only where a bin
// directory of npm's or bun's holds the command as a symbolic link to the
// launcher. Every scenario passes with it on Linux x64, macOS arm64 and
// Windows x64, with bun, npm and pnpm.
//
// Where a run through the launcher does not do what wtx.mjs does, as
// rustify documents it, the difference itself is asserted, so that a bun or
// a launcher that changes it is noticed:
//   - the user's own WTX_PACKAGE_ROOT: the launcher sets the variable to the
//     package's directory over it, and the binary takes that out, so the
//     session lacks it (every system; the binary run by itself passes it on);
//   - a preload that sets NODE_ENV, on Windows: bun writes it into the
//     launcher's own environment, which launcher v3 reads there, so
//     wtx.mjs's bun starts with it and reads .env.production, where wtx.mjs
//     run directly has loaded its .env files before the preload ran, and
//     read .env.development: the session gets the allow-listed names of
//     .env.production instead of those of .env.development, and no secret;
//   - an empty environment, started as `env -i <bun by its path> <command>`
//     (and the binary as `env -i <command>`): the binary gets nothing but
//     WTX_PACKAGE_ROOT, which it takes out, and starts wtx.mjs through its
//     #! line, where /usr/bin/env looks for bun as it does without PATH
//     (/bin:/usr/bin with glibc, /usr/bin:/bin on macOS). The runs are
//     compared with wtx.mjs started through its #! line in that
//     environment; and the launcher's run also with wtx.mjs run by that bun
//     where /usr/bin/env finds a bun, while where it does not, the
//     launcher's run ends in env's words with exit 127 and wtx.mjs run by
//     that bun starts the server: that is printed. The .env sets PATH, so a
//     launcher that passed process.env on would get past env there.
//
// The session's environment is also checked, on every run, against what
// wtx.mjs is meant to give it: of the .env files the values of exactly the
// allow-listed names the scenario expects (bun picks .env.<NODE_ENV> by the
// NODE_ENV the command was started with: .env.development here, though .env
// says NODE_ENV=production), no variable of the files whose name is not on
// the list, whatever its value, and no secret's value under any name. The
// files are written here from lists of names and values; nothing here reads
// .env syntax. At the end one line names the variables of the .env files
// that reached a session on this system.
//
// The package managers and every run get an environment made here, not this
// script's: PATH and, on Windows, the system's own variables; a home
// directory of their own (HOME, USERPROFILE, APPDATA, LOCALAPPDATA), and a
// temp directory of their own. A session may hold more than that: on
// Windows, bun-pty adds the variables the user has set for good (the
// registry's), for wtx.mjs as for the binary. So where a session's
// environment differs, only the names are printed, and a value only where
// it is one this script wrote. npm is the npm on PATH (on Windows the
// npm-cli.js beside node.exe, since npm.cmd needs a shell), or
// PARITY_NPM_CLI, an npm-cli.js that this script's runtime runs (for a
// machine without npm); with neither, the npm installs are skipped, and it
// says so. pnpm is PARITY_PNPM_CLI, a pnpm.cjs or pnpm.mjs that bun runs
// (pnpm 11 wants node 22.13 or later), or else the pnpm on PATH where it
// runs (Linux and macOS); with neither, the pnpm installs are skipped, and
// it says so. pnpm keeps its global packages under PNPM_HOME, here a
// directory of the install's own. It prints one line per scenario and, at
// the end, how many passed, and exits 1 unless all did.

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
const BUN_VERSION = spawnSync("bun", ["--version"], { encoding: "utf8", cwd: os.tmpdir() }).stdout?.trim() || "?";
// The bun on PATH, by its path (the runs from an empty environment name it
// so), and whether /usr/bin/env finds a bun without PATH, where it looks
// then.
const BUN = isWindows ? "bun" : spawnSync("bun", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8", cwd: os.tmpdir() }).stdout;
const DEFAULT_BUN = !isWindows && spawnSync("/usr/bin/env", ["bun", "--version"], { env: {}, stdio: "ignore" }).status === 0;

// The launcher pack.mjs put in the package, and its version.
const launcherText = fs.readFileSync(path.join(dist, "main", "rustify", "wtx"), "utf8");
const version = Number(/rustify launcher v(\d+)/.exec(launcherText.slice(0, 400))?.[1] ?? 0);
if (version < 3) {
  console.log(
    `FAILED: the package's launcher is v${version || "?"} (from ${templates}). Before v3 it starts the binary with bun's process.env, ` +
      "which holds the working directory's .env files, and every terminal session would get them. " +
      "Pack with rustify's templates from launcher v3 on.",
  );
  process.exit(1);
}

// Faults of rustify's launcher that scenarios below show, found in the
// packed launcher's text: a scenario that fails says what rustify must
// change. (Which scenario shows which: its `fault`.)
const FAULTS = {
  versions: /if \(!process\.versions\.bun\) return null;/.test(launcherText)
    ? "the packed launcher's startEntries() begins with `if (!process.versions.bun) return null;` (rustify's templates/npm/launcher.cjs), so after a preload " +
      "that deletes process.versions.bun it reads nothing, and binaryEnvironment() passes bun's process.env on, .env files included. rustify must remove that line: " +
      "under node bun:ffi throws on macOS and Windows, so process.env is used there as now, and /proc/self/environ is right under either runtime"
    : null,
  askedInTry: /try \{\s*if \(entries\) env = environmentOf\(entries, windows\);\s*if \(env\) for \(const name of TAKEN\) if \(!\(name in process\.env\)\)/.test(launcherText)
    ? "the packed launcher's binaryEnvironment() asks `name in process.env` of the IPC variables inside the try that guards the read (rustify's " +
      "templates/npm/launcher.cjs before 23f6df4), so a process.env that throws there makes it pass process.env on, .env files included; rustify 23f6df4 asks outside it"
    : null,
};

const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wtx-launcher-")));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// On Windows a process that has just been stopped can hold its directory a
// moment longer (EPERM, EBUSY): removing is tried again for up to 10 s.
const remove = (target) => fs.rmSync(target, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });

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
  try {
    remove(work);
  } catch (error) {
    console.log(`(${work} could not be removed yet: ${error.code}; the run that holds it ends within 30 s)`);
  }
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

// On Windows npm is a batch file, which node starts only through a shell:
// there it is the npm-cli.js that comes with node, beside node.exe.
const besideNode = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmCli = process.env.PARITY_NPM_CLI || (isWindows && !process.versions.bun && fs.existsSync(besideNode) ? besideNode : null);
const hasNpm = npmCli ? fs.existsSync(npmCli) : !isWindows && spawnSync("npm", ["--version"], { stdio: "ignore" }).status === 0;
const npm = (args, options) => (npmCli ? run(process.execPath, [npmCli, ...args], options) : run("npm", args, options));
// pnpm 11 wants node 22.13 or later; bun runs it anywhere.
const pnpmCli = process.env.PARITY_PNPM_CLI || null;
const pnpmProbe = pnpmCli || isWindows ? null : spawnSync("pnpm", ["--version"], { encoding: "utf8", env: toolEnv, cwd: work });
const hasPnpm = pnpmCli ? fs.existsSync(pnpmCli) : pnpmProbe?.status === 0;
const pnpm = (args, options) => (pnpmCli ? run("bun", [pnpmCli, ...args], options) : run("pnpm", args, options));

/** The package as `<dir>/node_modules/@snomiao/wtx`, `dir` being `from` or below it, at most `depth`
 *  directories down and not inside a node_modules (all in a directory of this script's own). */
function findPackage(from, depth) {
  const pkg = path.join(from, "node_modules", "@snomiao", "wtx");
  if (fs.existsSync(path.join(pkg, "wtx.mjs"))) return pkg;
  if (depth === 0) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const found = findPackage(path.join(from, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** Installs the package afresh into `dir`: how to start the command, and where the package is. */
async function install(installer, dir) {
  if (installer === "pnpm") {
    // pnpm puts its global packages and the store under PNPM_HOME, and the
    // commands in PNPM_HOME/bin (pnpm 11; PNPM_HOME itself before), which
    // it wants on PATH.
    const env = { ...toolEnv, PNPM_HOME: dir, PATH: [path.join(dir, "bin"), dir, toolEnv.PATH].join(path.delimiter) };
    for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) env[name] = path.join(dir, "xdg", name);
    const done = await pnpm(["add", "-g", NAME, "--registry", registry.url], { env, cwd: work });
    if (done.status !== 0) throw new Error(`pnpm add -g failed:\n${done.output}`);
    const shim = [path.join(dir, "bin"), dir].map((bin) => path.join(bin, isWindows ? "wtx.cmd" : "wtx")).find((file) => fs.existsSync(file));
    const pkg = findPackage(path.join(dir, "global"), 3);
    if (!shim || !pkg) throw new Error(`pnpm add -g wrote no command or no package where looked for:\n${done.output}`);
    if (isWindows) {
      // pnpm's wtx.cmd starts the launcher with .JS taken out of PATHEXT
      // (where no bun.exe is beside it), and so would its shim of the
      // published package, whose bin is wtx.mjs with the same #! line: that
      // shim is this one naming wtx.mjs, and wtx.mjs is started through it.
      const text = fs.readFileSync(shim, "utf8");
      const published = text.replaceAll('\\rustify\\wtx"', '\\wtx.mjs"');
      if (published === text || published.includes("rustify")) throw new Error(`pnpm's wtx.cmd is not as expected:\n${text}`);
      const direct = path.join(path.dirname(shim), "wtx-published.cmd");
      fs.writeFileSync(direct, published);
      const cmd = process.env.ComSpec || "cmd.exe";
      return { start: [cmd, ["/d", "/s", "/c", `"${shim}"`]], direct: [cmd, ["/d", "/s", "/c", `"${direct}"`]], viaCmd: true, shim, pkg };
    }
    // Its sh script runs `exec bun "<file>"`, as `bun <file>` does.
    return { start: [shim, []], shim, pkg };
  }
  if (installer === "bun") {
    const done = await run("bun", ["i", "-g", NAME, "--registry", registry.url], { env: { ...toolEnv, BUN_INSTALL: dir }, cwd: work });
    if (done.status !== 0) throw new Error(`bun i -g failed:\n${done.output}`);
    const shim = isWindows ? path.join(dir, "bin", "wtx.bunx") : null;
    return { start: [path.join(dir, "bin", isWindows ? "wtx.exe" : "wtx"), []], shim, pkg: path.join(dir, "install", "global", "node_modules", "@snomiao", "wtx") };
  }
  const done = await npm(["i", "-g", "--prefix", dir, NAME, "--registry", registry.url], { env: toolEnv, cwd: work });
  if (done.status !== 0) throw new Error(`npm i -g failed:\n${done.output}`);
  if (isWindows) {
    // As a command prompt starts npm's wtx.cmd.
    const cmd = path.join(dir, "wtx.cmd");
    return { start: [process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${cmd}"`]], viaCmd: true, shim: cmd, pkg: path.join(dir, "node_modules", "@snomiao", "wtx") };
  }
  return { start: [path.join(dir, "bin", "wtx"), []], shim: null, pkg: path.join(dir, "lib", "node_modules", "@snomiao", "wtx") };
}

/** Whether the installed command still starts the launcher: on Linux and macOS whether the
 *  package's rustify/wtx is still a script, on Windows whether the shim does not start the native
 *  copy beside it (rustify\wtx.exe) yet. */
function startsLauncher(installed) {
  if (!isWindows) return fs.readFileSync(path.join(installed.pkg, "rustify", "wtx")).subarray(0, 2).toString("latin1") === "#!";
  const shim = fs.readFileSync(installed.shim);
  const text = installed.shim.endsWith(".bunx") ? shim.toString("utf16le") : shim.toString("utf8");
  return !/rustify[\\/]wtx\.exe/i.test(text);
}

/** What pnpm's shim on Linux and macOS hands to a runtime: `exec bun "<file>"`, as its text says. */
function handedToRuntime(installed) {
  if (isWindows || !installed.shim) return null;
  const text = fs.readFileSync(installed.shim, "utf8");
  return /exec "?(?:\$basedir\/)?(bun|node)"? +"[^"\n]*rustify\/wtx"/.exec(text)?.[1] ?? null;
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
    'fs.renameSync(out + ".part", out);\nsetTimeout(() => {}, 30000);\n',
);

let runs = 0;

/** Starts the server with `start` in a directory of its own with the scenario's files, drives it,
 *  stops it: what was seen, with that directory written <RUN>. (Each run has its own: on Windows
 *  a directory can stay held a while after the server in it has been stopped.) The .env files'
 *  values are written with <RUN> and <PORT> in place, and seen as they were written. */
async function serve(start, verbatim, scenario) {
  const runDir = path.join(work, `run-${++runs}`);
  const cwd = path.join(runDir, "cwd");
  const tmp = path.join(runDir, "tmp");
  const sessionDir = path.join(runDir, "session");
  const dump = path.join(runDir, "session-env.txt");
  for (const dir of [cwd, tmp, sessionDir, path.join(runDir, "home")]) fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const expand = (value) => value.replaceAll("<RUN>", runDir).replaceAll("<PORT>", String(port));
  for (const [name, entries] of Object.entries(scenario.dotenv)) {
    fs.writeFileSync(path.join(cwd, name), Object.entries(entries).map(([key, value]) => `${key}=${expand(value)}\n`).join(""));
  }
  for (const [name, text] of Object.entries(scenario.files?.(runDir) ?? {})) fs.writeFileSync(path.join(cwd, name), text);
  // From nothing at all (env -i), or what a user's shell would give.
  const env = scenario.empty
    ? {}
    : { ...baseEnv(tmp), USER_OWN: "mine", LC_USER_OWN: "mine", TERMINAL_WS_PORT: String(port), TERMINAL_WS_HOST: "127.0.0.1", ...scenario.env?.(runDir) };
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
    // The session's program stays (for at most 30 s) once it has written
    // its environment: bun-pty sometimes does not report the end of one that
    // exits at once, not even after 15 s (once in some 100 runs, on a busy
    // machine), and it is stopped with the server.
    const program = isWindows ? [process.execPath, path.join(work, "dump-env.cjs"), dump] : ["/bin/sh", "-c", 'env > "$0.part" && mv "$0.part" "$0" && exec sleep 30', dump];
    await ask("POST", "/sessions/s", { cmd: program, cwd: sessionDir });
    if (!(await until(() => fs.existsSync(dump), 15000))) seen.push("(the session did not write its environment)");
    // Then until the server's log and the session's buffer (on Windows,
    // ConPTY's own sequences) have been quiet for half a second: bun writes
    // its log to a pipe a moment later, and what it has not written yet is
    // lost when it is stopped.
    let last = "";
    let since = Date.now();
    await until(async () => {
      let now = text("stdout") + text("stderr");
      try {
        now += JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/sessions`)).json()).map((s) => s.bufferBytes));
      } catch {}
      if (now !== last) [last, since] = [now, Date.now()];
      return Date.now() - since >= 500;
    }, 10000);
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
  // The run's directory as written in JSON, as it is, and with forward slashes (BUN_OPTIONS on Windows).
  const spellings = [JSON.stringify(runDir).slice(1, -1), runDir, runDir.replaceAll("\\", "/")];
  const plain = (s) =>
    spellings
      .reduce((text, spelling) => text.replaceAll(spelling, "<RUN>"), s)
      .replaceAll(String(port), "<PORT>")
      .replace(/"(startedAt|lastActivity)":( ?)("[^"]*"|\d+)/g, '"$1":$2<time>');
  return {
    ended: isWindows ? "(stopped by taskkill)" : ended,
    stdout: plain(text("stdout")),
    stderr: plain(text("stderr")),
    http: plain(seen.join("\n")),
    sessionEnv: plain(read(dump)),
    preloads: plain(read(path.join(cwd, "preloads.log"))),
    files: listing(cwd),
    tmp: listing(tmp),
  };
}

// ── the scenarios ───────────────────────────────────────────────────────────

/** Two variables a preload sets in process.env. */
const SETS = (name) => `process.env.LC_FROM_PRELOAD_${name} = "allowed";\nprocess.env.SECRET_FROM_PRELOAD_${name} = "secret-from-preload-${name}";\n`;
/** The same, after deleting DROP_ME, a variable the command was started with. */
const DROPS = (name) => `delete process.env.DROP_ME;\n${SETS(name)}`;
/** The same, after deleting process.versions.bun (as a preload may, so that a library takes bun for node). */
const UNBUN = (name) => `delete process.versions.bun;\n${SETS(name)}`;
/** The same, after putting in process.env's place an object that throws when asked `name in process.env`. */
const THROWS = (name) => `const real = process.env;\nprocess.env = new Proxy(real, { has() { throw new Error("no in"); } });\n${SETS(name)}`;
/** A preload that says where it ran (the file bun was started with), logs it, and does `body`. */
const preload = (name, log, body = SETS(name)) =>
  'import fs from "node:fs";\nimport path from "node:path";\n' +
  'const where = path.basename(process.argv[1] ?? "");\n' +
  `console.error(\`preload ${name} ran in \${where}\`);\n` +
  `fs.appendFileSync(${JSON.stringify(log)}, \`${name} \${where}\\n\`);\n` +
  body;
// Of a run's directory (see serve).
const log = (runDir) => path.join(runDir, "cwd", "preloads.log");
/** A bunfig.toml with a preload, whose body is body(name) (SETS by default). */
const bunfig = (body) => (runDir) => ({ "bunfig.toml": 'preload = ["./pre-bunfig.mjs"]\n', "pre-bunfig.mjs": preload("bunfig", log(runDir), body?.("bunfig")) });
/** BUN_OPTIONS with a preload, whose body is body(name) (SETS by default). */
const options = (body) => (runDir) => {
  fs.writeFileSync(path.join(runDir, "pre-options.mjs"), preload("options", log(runDir), body?.("options")));
  // bun reads a backslash in BUN_OPTIONS as an escape: C:/… on Windows.
  return { BUN_OPTIONS: `--preload ${path.join(runDir, "pre-options.mjs").replaceAll("\\", "/")}` };
};

// The .env files of a scenario: file → name → value, written as NAME=value
// lines (see serve). A name in two files has a value of its own in each, so
// that what a session holds says which file it came from.
const ENV = {
  ".env": { TERMINAL_ACCESS_KEY: "key-from-dotenv", PARITY_API_SECRET: "secret-from-dotenv", NODE_ENV: "production", LC_FROM_DOTENV: "allowed-from-dotenv" },
  ".env.production": { LC_FROM_PRODUCTION: "read", SECRET_FROM_PRODUCTION: "secret-from-production", WTX_REPO_BASE: "/from/env/production" },
  ".env.development": { LC_FROM_DEVELOPMENT: "read", SECRET_FROM_DEVELOPMENT: "secret-from-development" },
};
/** Every .env file bun reads where the command was started without NODE_ENV (.env, .env.local,
 *  .env.development and its .local), and two it does not read then, with names on the allow-list
 *  and secrets in each. */
const EVERY = {
  ".env": {
    GH_TOKEN: "gh-from-dotenv",
    EDITOR: "editor-from-dotenv",
    XDG_FROM_DOTENV: "xdg-from-dotenv",
    BUN_FROM_DOTENV: "bun-from-dotenv",
    GIT_FROM_DOTENV: "git-from-dotenv",
    LC_FROM_DOTENV: "allowed-from-dotenv",
    TERMINAL_ACCESS_KEY: "key-from-dotenv",
    PARITY_API_SECRET: "secret-from-dotenv",
  },
  ".env.local": { GITHUB_TOKEN: "ghp-from-local", LC_FROM_LOCAL: "local", SECRET_FROM_LOCAL: "secret-from-local" },
  ".env.development": { GITHUB_OWNER: "owner-from-development", NODE_FROM_DEVELOPMENT: "read", SECRET_FROM_DEVELOPMENT: "secret-from-development" },
  ".env.development.local": { LC_FROM_DEVELOPMENT_LOCAL: "read", SECRET_FROM_DEVELOPMENT_LOCAL: "secret-from-development-local" },
  ".env.production": { GITHUB_OWNER: "owner-from-production", LC_FROM_PRODUCTION: "read", SECRET_FROM_PRODUCTION: "secret-from-production" },
  ".env.production.local": { LC_FROM_PRODUCTION_LOCAL: "read", SECRET_FROM_PRODUCTION_LOCAL: "secret-from-production-local" },
};
/** For a preload that sets NODE_ENV: a .env without it, and an allow-listed GH_TOKEN in .env.production. */
const NO_NODE_ENV = {
  ".env": { TERMINAL_ACCESS_KEY: "key-from-dotenv", PARITY_API_SECRET: "secret-from-dotenv", LC_FROM_DOTENV: "allowed-from-dotenv" },
  ".env.production": { LC_FROM_PRODUCTION: "read", GH_TOKEN: "gh-from-production", SECRET_FROM_PRODUCTION: "secret-from-production" },
  ".env.development": ENV[".env.development"],
};
/** From an empty environment the .env gives wtx.mjs's bun all it has: where to listen, PATH (with
 *  this bun's directory), HOME and TMPDIR (of the run's own). */
const EMPTY = {
  ".env": { PATH: `${path.dirname(BUN)}:/usr/bin:/bin`, HOME: "<RUN>/home", TMPDIR: "<RUN>/tmp", TERMINAL_WS_PORT: "<PORT>", TERMINAL_WS_HOST: "127.0.0.1", ...ENV[".env"] },
  ".env.production": ENV[".env.production"],
  ".env.development": ENV[".env.development"],
};
/** For BUN_OPTIONS=--env-file: then bun reads that file and none of the others. */
const ENV_FILE = { ...ENV, "extra.env": { LC_FROM_ENVFILE: "read", NODE_ENV: "staging", SECRET_FROM_ENVFILE: "secret-from-envfile" } };

// The names on wtx.mjs's allow-list (src/server.ts, ALLOW_ENV_NAMES and
// ALLOW_ENV_PREFIXES) that these files use; the others must never reach a
// session. And what a secret's value looks like: it must not reach a
// session under any name.
const LISTED = /^(LC_|NODE_|XDG_|BUN_|GIT_)|^(PATH|HOME|TMPDIR|EDITOR|GH_TOKEN|GITHUB_TOKEN|GITHUB_OWNER)$/;
const SECRET = /^(secret|key)-/;
/** The entries ("<file> <NAME>") of `files` whose names are on the list, in the files bun reads. */
const listedIn = (files, read) => read.flatMap((file) => Object.keys(files[file]).filter((name) => LISTED.test(name)).map((name) => `${file} ${name}`));

const scenarios = [
  { name: "a .env, .env.production, a bunfig.toml preload and BUN_OPTIONS with a preload", dotenv: ENV, files: bunfig(), env: options(), pnpm: true },
  { name: "the same where the launcher cannot link (RUSTIFY_NO_LINK=1)", dotenv: ENV, files: bunfig(), env: (d) => ({ ...options()(d), RUSTIFY_NO_LINK: "1" }), noLink: true, pnpm: true },
  { name: "a .env, .env.production and BUN_OPTIONS with a preload, no bunfig.toml", dotenv: ENV, env: options() },
  { name: "a .env, .env.production and BUN_OPTIONS without a preload", dotenv: ENV, env: () => ({ BUN_OPTIONS: "--smol" }) },
  { name: "a bunfig.toml preload that deletes DROP_ME, a variable the command was started with", dotenv: ENV, files: bunfig(DROPS), env: () => ({ DROP_ME: "exported" }), drops: true },
  { name: "the same with RUSTIFY_NO_LINK=1", dotenv: ENV, files: bunfig(DROPS), env: () => ({ DROP_ME: "exported", RUSTIFY_NO_LINK: "1" }), noLink: true, drops: true },
  { name: "a BUN_OPTIONS preload that deletes DROP_ME", dotenv: ENV, env: (d) => ({ ...options(DROPS)(d), DROP_ME: "exported" }), drops: true },
  { name: "the same with RUSTIFY_NO_LINK=1", dotenv: ENV, env: (d) => ({ ...options(DROPS)(d), DROP_ME: "exported", RUSTIFY_NO_LINK: "1" }), noLink: true, drops: true },
  {
    name: "an empty environment (env -i), with a .env and .env.development",
    dotenv: EMPTY,
    reach: listedIn(EMPTY, [".env", ".env.development"]),
    empty: true,
    skip:
      isWindows &&
      "node (libuv) adds the variables a Windows program needs (PATH, SYSTEMROOT, TEMP, USERPROFILE, ...) to every environment it starts a program with, so no run here starts from an empty one",
  },
  {
    name: "a bunfig.toml preload that sets NODE_ENV=production, with a .env that does not",
    dotenv: NO_NODE_ENV,
    files: bunfig(() => 'process.env.NODE_ENV = "production";\n'),
    reach: listedIn(NO_NODE_ENV, [".env", ".env.development"]),
    launcher: () =>
      isWindows && {
        names: ["LC_FROM_DEVELOPMENT", "LC_FROM_PRODUCTION", "GH_TOKEN"],
        reach: (want) => [...want.filter((entry) => entry !== ".env.development LC_FROM_DEVELOPMENT"), ".env.production LC_FROM_PRODUCTION", ".env.production GH_TOKEN"].sort(),
        says:
          "on a run through the launcher the preload's NODE_ENV reached wtx.mjs's bun, which read .env.production (the session got its LC_FROM_PRODUCTION and GH_TOKEN) " +
          `and not .env.development, where wtx.mjs run directly read .env.development, as rustify documents for Windows (bun ${BUN_VERSION})`,
      },
  },
  { name: "every .env file bun reads here, and two it does not, with allow-listed names and secrets", dotenv: EVERY, reach: listedIn(EVERY, [".env", ".env.local", ".env.development", ".env.development.local"]), pnpm: true },
  {
    name: "BUN_OPTIONS=--env-file, with an allow-listed name, NODE_ENV and a secret",
    dotenv: ENV_FILE,
    env: (d) => ({ BUN_OPTIONS: `--env-file=${path.join(d, "cwd", "extra.env").replaceAll("\\", "/")}` }),
    reach: listedIn(ENV_FILE, ["extra.env"]),
  },
  {
    name: "the user's own WTX_PACKAGE_ROOT, naming another directory",
    dotenv: ENV,
    env: (d) => {
      fs.mkdirSync(path.join(d, "other"), { recursive: true });
      return { WTX_PACKAGE_ROOT: path.join(d, "other") };
    },
    ownRoot: true,
    launcher: () => ({
      names: ["WTX_PACKAGE_ROOT"],
      check: (want, got) =>
        want.has("WTX_PACKAGE_ROOT") && !got.has("WTX_PACKAGE_ROOT") ? [] : [`WTX_PACKAGE_ROOT: wtx.mjs ${shown(want, "WTX_PACKAGE_ROOT")}, here ${shown(got, "WTX_PACKAGE_ROOT")}, where rustify's launcher sets its own value, which the binary takes out`],
      says: "on a run through the launcher the session lacks the user's WTX_PACKAGE_ROOT: the launcher set the package's directory over it, and the binary took that out",
    }),
  },
  { name: "a bunfig.toml preload that sets a long process.title", dotenv: ENV, files: bunfig((name) => `${SETS(name)}process.title = "t".repeat(4000);\n`) },
  // The verifier's (2026-11-28): a launcher that reads nothing without process.versions.bun, or
  // that asks process.env inside the try that guards the read, passes bun's process.env on.
  { name: "a bunfig.toml preload that deletes process.versions.bun", dotenv: ENV, files: bunfig(UNBUN), fault: "versions" },
  { name: "the same with RUSTIFY_NO_LINK=1", dotenv: ENV, files: bunfig(UNBUN), env: () => ({ RUSTIFY_NO_LINK: "1" }), noLink: true, fault: "versions" },
  { name: "a BUN_OPTIONS preload that deletes process.versions.bun", dotenv: ENV, env: options(UNBUN), fault: "versions" },
  { name: "a bunfig.toml preload that puts in process.env's place an object that throws when asked `name in process.env`", dotenv: ENV, files: bunfig(THROWS), fault: "askedInTry" },
];
for (const scenario of scenarios) {
  scenario.reach ??= listedIn(scenario.dotenv, [".env", ".env.development"]);
  for (const entry of scenario.reach) if (!LISTED.test(entry.split(" ")[1])) throw new Error(`${scenario.name}: ${entry} is not on the allow-list`);
}

/** A session's environment, by name. */
const variables = (envText) =>
  new Map(
    envText
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

// The values this script writes: the only ones it prints. A session can also
// hold variables of the machine's own (on Windows, bun-pty adds the user's
// persistent ones), whose values stay unseen.
const WRITTEN = new Set(["mine", "exported", "allowed", "1", "production", "staging", "127.0.0.1", "<PORT>", ...scenarios.flatMap((s) => Object.values(s.dotenv).flatMap(Object.values))]);
const shown = (vars, name) => {
  if (!vars.has(name)) return "not set";
  const value = vars.get(name);
  return WRITTEN.has(value) || value.includes("<RUN>") || /^secret-from-preload-/.test(value) ? JSON.stringify(value) : "set (value not shown)";
};
const list = (entries) => entries.join(", ") || "nothing";

/** The entries ("<file> <NAME>") of the scenario's .env files whose value a session holds under their name. */
function reachedOf(vars, scenario) {
  const out = [];
  for (const [file, entries] of Object.entries(scenario.dotenv)) for (const [name, value] of Object.entries(entries)) if (vars.get(name) === value) out.push(`${file} ${name}`);
  return out.sort();
}

/** What of the scenario's .env files a session holds that it never may: a name not on the
 *  allow-list (with any value), or a secret's value under another name. */
function leaks(vars, scenario) {
  const problems = [];
  for (const [file, entries] of Object.entries(scenario.dotenv)) {
    for (const [name, value] of Object.entries(entries)) {
      if (!LISTED.test(name) && vars.has(name)) problems.push(`got ${name}, which ${file} has and the allow-list does not`);
      if (SECRET.test(value)) for (const [other, held] of vars) if (held === value && other !== name) problems.push(`got ${file}'s ${name} as ${other}`);
    }
  }
  return problems;
}

/** What wtx.mjs run directly is meant to give a session: of the .env files exactly the entries the
 *  scenario expects, nothing that leaks, the user's own variables, and WTX_PACKAGE_ROOT only where
 *  the user set it. (What a preload sets in process.env is not held against it: on Windows bun
 *  writes that into the process's own environment too, which every session gets, under wtx.mjs as
 *  well; it is printed.) */
function directProblems(vars, scenario) {
  const problems = leaks(vars, scenario);
  const [got, want] = [reachedOf(vars, scenario), [...scenario.reach].sort()];
  if (got.join() !== want.join()) problems.push(`got of the .env files ${list(got)}, not ${list(want)}`);
  if (!scenario.empty) for (const name of ["USER_OWN", "LC_USER_OWN"]) if (vars.get(name) !== "mine") problems.push(`has ${name} ${shown(vars, name)}, not "mine"`);
  if (Boolean(scenario.ownRoot) !== vars.has("WTX_PACKAGE_ROOT")) problems.push(`has WTX_PACKAGE_ROOT ${shown(vars, "WTX_PACKAGE_ROOT")}`);
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

/** Each thing seen must be what was expected; in a session's environment, but for the variables
 *  named in `exempt`, which the caller checks. */
function compare(label, expected, got, exempt = []) {
  const problems = [];
  const without = (text) =>
    text
      .split("\n")
      .filter((line) => !exempt.includes(line.slice(0, Math.max(0, line.indexOf("=")))))
      .join("\n");
  for (const key of Object.keys(expected)) {
    const [a, b] = key === "sessionEnv" ? [without(expected[key]), without(got[key])] : [expected[key], got[key]];
    if (a === b) continue;
    if (key !== "sessionEnv") {
      // At most 1000 characters of each (a binary that bun was given to run prints itself).
      const cut = (text) => (text.length > 1000 ? `${JSON.stringify(text.slice(0, 1000))} and ${text.length - 1000} characters more` : JSON.stringify(text));
      problems.push(`${label}: ${key} differs\n      wtx.mjs: ${cut(a)}\n      ${label}: ${cut(b)}`);
      continue;
    }
    if (b === "(none)") {
      problems.push(`${label}: there was no session's environment to compare`);
      continue;
    }
    // Names, and only the values this script wrote: the rest may be the machine's own.
    const [va, vb] = [variables(a), variables(b)];
    const names = [...new Set([...va.keys(), ...vb.keys()])].filter((name) => va.get(name) !== vb.get(name)).sort();
    const order = names.length ? "" : " (the same variables, in another order)";
    problems.push(`${label}: the session's environment differs${order}${names.map((name) => `\n      ${name}: wtx.mjs ${shown(va, name)}, ${label} ${shown(vb, name)}`).join("")}`);
  }
  return problems;
}

const installers = ["bun", ...(hasNpm ? ["npm"] : []), ...(hasPnpm ? ["pnpm"] : [])];
if (!hasNpm) console.log("  skip    npm: not on this machine (nor PARITY_NPM_CLI)");
if (!hasPnpm) {
  let why = `the pnpm on PATH does not run (${JSON.stringify(`${pnpmProbe?.stderr || ""}${pnpmProbe?.stdout || ""}`.trim().split("\n")[0])})`;
  if (pnpmCli) why = `PARITY_PNPM_CLI names no file (${pnpmCli})`;
  else if (!pnpmProbe) why = "on Windows only PARITY_PNPM_CLI is tried (pnpm.cmd needs a shell)";
  else if (pnpmProbe.error) why = `not on this machine (${pnpmProbe.error.code})`;
  console.log(`  skip    pnpm: ${why}; PARITY_PNPM_CLI names a pnpm.cjs or pnpm.mjs that bun runs`);
}
for (const scenario of scenarios) if (scenario.skip) console.log(`  skip    ${scenario.name}: ${scenario.skip}`);
const active = scenarios.filter((scenario) => !scenario.skip);
let count = 0;
let passed = 0;
// Failures on a known fault of rustify's launcher (see FAULTS), which say so.
let known = 0;
const PNPM_FAULT =
  "pnpm's command is an sh script that runs `bun <the package>/rustify/wtx`, as the launcher's #! line says (pnpm links a command only with its hoisted node-linker), " +
  "and the launcher's first run put the binary in that file's place, which bun cannot run (`error: Unexpected`, exit 1): the command no longer starts. " +
  "rustify's launcher (templates/npm/launcher.cjs, prepare()) must not link over itself on Linux and macOS where it cannot see that the system starts the file by its #! line";
// Of the .env files, over every session: the names whose values reached one, and how many sessions.
const reachedNames = new Set();
let sessions = 0;
for (const installer of installers) {
  for (const [index, scenario] of active.entries()) {
    if (installer === "pnpm" && !scenario.pnpm) continue;
    const caseDir = path.join(work, `${installer}-${index}`);
    fs.mkdirSync(caseDir, { recursive: true });
    const title = `${installer}: ${scenario.name}`;
    const problems = [];
    const notes = [];
    const cased = new Set();
    const differed = new Set();
    const causes = new Set();
    try {
      const installed = await install(installer, path.join(caseDir, "inst"));
      // wtx.mjs as the published command starts it; through a command prompt
      // where npm's wtx.cmd starts the installed command (cmd.exe adds PROMPT
      // to what its programs get), and through pnpm's shim for it where
      // pnpm's starts it (see install); from an empty environment by bun's
      // path, and also through its #! line, as the system starts the
      // published command.
      const script = path.join(installed.pkg, "wtx.mjs");
      const cmd = process.env.ComSpec || "cmd.exe";
      const direct = await serve(installed.direct ?? (installed.viaCmd ? [cmd, ["/d", "/s", "/c", `""bun" "${script}""`]] : [scenario.empty ? BUN : "bun", [script]]), installed.viaCmd, scenario);
      const shebang = scenario.empty ? await serve([script, []], false, scenario) : null;
      const seenAll = [direct, shebang].filter(Boolean);
      problems.push(...directProblems(variables(direct.sessionEnv), scenario).map((p) => `wtx.mjs: the session ${p}`));
      if (shebang) problems.push(...leaks(variables(shebang.sessionEnv), scenario).map((p) => `wtx.mjs through its #! line: the session ${p}`));
      const reached = [...variables(direct.sessionEnv).keys()].filter((name) => /^SECRET_FROM_PRELOAD_/i.test(name));
      if (direct.preloads !== "(none)" && direct.preloads.split("\n").some((line) => line && !/ wtx\.mjs$/.test(line))) problems.push(`wtx.mjs: a preload ran elsewhere: ${direct.preloads}`);
      let linked = false;
      let ranBinary = null;
      for (const run of [1, 2]) {
        if (run === 2) {
          // What the first run left: with bun and npm the binary in the
          // launcher's place, but where it may not link.
          linked = !startsLauncher(installed);
          ranBinary = linked ? handedToRuntime(installed) : null;
          if (installer !== "pnpm" && linked === Boolean(scenario.noLink)) {
            problems.push(scenario.noLink ? "the first run put the binary in the launcher's place, under RUSTIFY_NO_LINK=1" : "the first run did not put the binary in the launcher's place");
          }
          if (installer === "pnpm") notes.push(ranBinary ? `pnpm's shim then ran \`${ranBinary} <the binary>\`` : linked ? "pnpm's shim then started the binary" : "pnpm's shim then started the launcher again");
        }
        const throughLauncher = run === 1 || !linked;
        const label = run === 1 ? "first run" : !linked ? "second run (the launcher again)" : ranBinary ? `second run (${ranBinary} <the binary>, as pnpm's shim runs it)` : "second run (the binary)";
        // From an empty environment the launcher is started by bun's path, the binary as the system starts it.
        const seen = await serve(scenario.empty && throughLauncher ? [BUN, [installed.start[0]]] : installed.start, installed.viaCmd, scenario);
        seenAll.push(seen);
        const { printed, logged, rest } = withoutLauncher(seen);
        let expected = scenario.empty && !(throughLauncher && DEFAULT_BUN) ? shebang : direct;
        if (isWindows && printed.length) {
          // bun on Windows writes what the launcher's preload set in
          // process.env into the launcher's environment, in capitals, and
          // launcher v3 passes that on: the binary, and wtx.mjs's bun after
          // it, start with those variables, and the session gets them under
          // that spelling. Windows takes the two spellings for one variable.
          const set = new Set(printed.flatMap((p) => [`LC_FROM_PRELOAD_${p}`, `SECRET_FROM_PRELOAD_${p}`].map((name) => name.toUpperCase())));
          const fold = (text) =>
            text
              .split("\n")
              .map((line) => {
                const name = line.slice(0, Math.max(0, line.indexOf("=")));
                return set.has(name.toUpperCase()) ? name.toUpperCase() + line.slice(name.length) : line;
              })
              .join("\n");
          if (rest.sessionEnv !== expected.sessionEnv && fold(rest.sessionEnv) === fold(expected.sessionEnv)) cased.add(label);
          expected = { ...expected, sessionEnv: fold(expected.sessionEnv) };
          rest.sessionEnv = fold(rest.sessionEnv);
        }
        // Where rustify documents that a run through the launcher differs.
        const differs = (throughLauncher && scenario.launcher?.()) || null;
        problems.push(...compare(label, expected, rest, differs?.names));
        const [want, got] = [variables(expected.sessionEnv), variables(rest.sessionEnv)];
        problems.push(...leaks(got, scenario).map((p) => `${label}: the session ${p}`));
        if (differs) {
          const wantReach = (differs.reach ?? ((entries) => entries))(reachedOf(want, scenario));
          const gotReach = reachedOf(got, scenario);
          if (gotReach.join() !== wantReach.join()) {
            problems.push(`${label}: of the .env files the session got ${list(gotReach)}, where rustify's documented difference gives ${list(wantReach)} (bun ${BUN_VERSION}: has bun changed?)`);
          }
          problems.push(...(differs.check?.(want, got) ?? []).map((p) => `${label}: ${p}`));
          differed.add(differs.says);
        }
        if (printed.join() !== logged.join()) problems.push(`${label}: the launcher's preloads printed ${JSON.stringify(printed)} but logged ${JSON.stringify(logged)}`);
        if (!throughLauncher && printed.length) problems.push(`${label}: a preload ran in the launcher`);
        if (run === 1) notes.push(printed.length ? `ran once more, in the launcher: ${printed.join(", ")}` : "no preload ran in the launcher");
        if (run === 2 && ranBinary && problems.some((p) => p.startsWith(label))) causes.add(PNPM_FAULT);
      }
      if (scenario.empty) {
        notes.push(
          DEFAULT_BUN
            ? "/usr/bin/env finds a bun without PATH here: every run started the server"
            : `/usr/bin/env finds no bun without PATH here: the launcher's run ended as wtx.mjs through its #! line did (${JSON.stringify(shebang.stderr.split("\n")[0])}, ${shebang.ended}), where wtx.mjs run by bun's path ${/listening/.test(direct.stdout) ? "started the server" : "did not start the server either"}`,
        );
      }
      if (scenario.drops) notes.push(`DROP_ME ${variables(direct.sessionEnv).has("DROP_ME") ? "reached" : "did not reach"} the session, as under wtx.mjs`);
      notes.push(...differed);
      if (reached.length) notes.push(`what a preload set reached the sessions of wtx.mjs too (${reached.join(", ")})`);
      if (cased.size) notes.push(`the launcher's preload's variables reached the binary, a session gets them in capitals (${[...cased].join(", ")})`);
      for (const seen of seenAll) {
        if (seen.sessionEnv === "(none)") continue;
        sessions++;
        for (const entry of reachedOf(variables(seen.sessionEnv), scenario)) reachedNames.add(entry.split(" ")[1]);
      }
    } catch (error) {
      problems.push(error.message);
    }
    count++;
    if (problems.length) {
      // A fault of the launcher shows on the runs through it.
      const onLauncher = problems.some((p) => p.startsWith("first run") || p.startsWith("second run (the launcher again)"));
      if (scenario.fault && FAULTS[scenario.fault] && onLauncher) causes.add(FAULTS[scenario.fault]);
      if (causes.size) known++;
      console.log(`  FAILED  ${title}\n    ${problems.join("\n    ")}${[...causes].map((cause) => `\n    known fault of rustify's launcher: ${cause}`).join("")}`);
    } else {
      passed++;
      console.log(`  ok      ${title}; ${notes.join("; ")}`);
    }
  }
}
{
  const names = [...reachedNames].sort();
  const off = names.filter((name) => !LISTED.test(name));
  console.log(
    `of the .env files, ${sessions} sessions on ${process.platform} got the values of ${list(names.filter((name) => LISTED.test(name)))}, ` +
      `on wtx.mjs's allow-list; ${off.length ? `and of ${off.join(", ")}, which are not (FAILED above)` : "and nothing of the other names"}`,
  );
}
console.log(
  `${passed} of ${count} installs: the first run and the second as wtx.mjs run directly, but for the launcher's own run of a preload and where said` +
    (passed === count ? "" : `; ${count - passed} failed, ${known} of them on a known fault of rustify's launcher (said there)`),
);
finish(passed === count ? 0 : 1);
