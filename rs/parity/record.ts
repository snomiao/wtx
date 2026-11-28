#!/usr/bin/env bun
// Records what the TypeScript answers, for the Rust modules' tests:
//
//   bun rs/parity/record.ts           # rewrite rs/src/testdata/*.json
//   bun rs/parity/record.ts --check   # fail unless they are what this bun records
//
// from anywhere, after `bun install` in the repository. Every answer comes
// from the TypeScript's own code, run by bun on generated inputs:
//
//   js.json       JavaScript itself, as the TypeScript uses it: parseInt,
//                 String(number), JSON.stringify of a string, trim,
//                 decodeURIComponent, URLSearchParams, TextDecoder (also
//                 with { stream: true }, as bun-pty decodes a terminal)
//   summary.json  summarizeTerminal of src/term-summary.ts
//   server.json   functions of src/server.ts that it does not export
//                 (sessionName, validateCwd, extractOsc7Cwd, the PTY's
//                 environment, bufferPush, the fallback renderer) and some it
//                 does (negotiateSize, getTerminalStatusForRepo,
//                 getTermSummaryForCwd)
//   scenarios.json  the server itself, request by request (see "scenarios")
//
// src/server.ts is loaded as it is, transpiled, with these changes made to
// its text (and the recorder stops if one of them no longer finds its
// place, so that a change to the TypeScript cannot slip past it):
//   - an export of the functions it keeps to itself;
//   - bun-pty's own Terminal class (node_modules/bun-pty/src/terminal.ts),
//     with its native library replaced by a stand-in that records what it is
//     asked and answers what a scenario says (it never starts a program);
//   - Bun.serve, Bun.spawn (git), Date.now, setTimeout/clearTimeout (the
//     resize debounce), os.hostname, existsSync/mkdirSync of validateCwd and
//     the process.env the PTY's environment is taken from, all answered by
//     this script;
//   - @xterm/headless renamed, so that the fallback renderer is the one used.
// Nothing listens, nothing is started, and only a temp directory of this
// script's own is written (the koho-term-zshrc that server.ts writes when it
// is loaded).

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const testdata = join(root, "rs/src/testdata");
const check = process.argv.includes("--check");

const work = mkdtempSync(join(tmpdir(), "wtx-record-"));
for (const name of ["TMPDIR", "TEMP", "TMP"]) process.env[name] = work;

// ── a generator of inputs: the same ones on every run ───────────────────────

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}
type Rand = () => number;
const pick = <T,>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const below = (r: Rand, n: number) => Math.floor(r() * n);
const join_ = (r: Rand, pieces: readonly string[], max: number) => {
  let s = "";
  for (let n = 1 + below(r, max); n > 0; n--) s += pick(r, pieces);
  return s;
};
/** A number as JSON cannot hold it (NaN, -0, the infinities): its String(), with -0 told apart. */
const num = (x: number) => (Object.is(x, -0) ? "-0" : String(x));
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bits = (x: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return hex(new Uint8Array(view.buffer));
};

// ── the TypeScript, loaded with its stand-ins ───────────────────────────────

/** Replaces `from` by `to` in `text`, exactly `count` times, or stops. */
function patch(text: string, from: string, to: string, count = 1, what = "src/server.ts") {
  const found = text.split(from).length - 1;
  if (found !== count) throw new Error(`${what}: expected ${count} of ${JSON.stringify(from)}, found ${found}; rs/parity/record.ts needs updating`);
  return text.split(from).join(to);
}

const transpiler = new Bun.Transpiler({ loader: "ts" });

let terminalSource = readFileSync(join(root, "node_modules/bun-pty/src/terminal.ts"), "utf8");
{
  const start = terminalSource.indexOf("const libPath = resolveLibPath();");
  const endMark = 'console.error("Failed to load lib", error);\n}';
  const end = terminalSource.indexOf(endMark);
  if (start < 0 || end < start) throw new Error("bun-pty's terminal.ts: the library loading was not found; rs/parity/record.ts needs updating");
  terminalSource = terminalSource.slice(0, start) + "const lib: any = { get symbols() { return (globalThis as any).__wtxRecord.lib.symbols; } };\n" + terminalSource.slice(end + endMark.length);
  terminalSource = patch(terminalSource, "ptr(buf)", "buf", 2, "bun-pty's terminal.ts");
  terminalSource = patch(terminalSource, 'from "./interfaces"', `from ${JSON.stringify(join(root, "node_modules/bun-pty/src/interfaces.ts"))}`, 2, "bun-pty's terminal.ts");
}
writeFileSync(join(work, "terminal.mjs"), transpiler.transformSync(terminalSource));
const { Terminal } = await import(join(work, "terminal.mjs"));

let serverSource = readFileSync(join(root, "src/server.ts"), "utf8");
const R = "globalThis.__wtxRecord";
serverSource = patch(serverSource, 'require("bun-pty")', `${R}.ptyModule`);
serverSource = patch(serverSource, "hostname()", `${R}.hostname`, 2);
serverSource = patch(serverSource, 'import("@xterm/headless")', 'import("@xterm/headless-is-not-loaded-by-the-recorder")');
serverSource = patch(serverSource, "if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });", `if (!${R}.exists(resolved)) ${R}.mkdir(resolved);`);
serverSource = patch(serverSource, "scrubSecrets(process.env)", `scrubSecrets(${R}.env)`);
serverSource = patch(serverSource, "process.env.PROMPT_COMMAND", `${R}.env.PROMPT_COMMAND`, 2);
serverSource = patch(serverSource, "process.env.SHELL", `${R}.env.SHELL`, 2);
serverSource = patch(serverSource, "process.env.WTX_DEFAULT_CWD", `${R}.env.WTX_DEFAULT_CWD`);
serverSource = patch(serverSource, "process.cwd()", `${R}.cwd`);
serverSource = patch(serverSource, "Date.now()", `${R}.now()`, 7);
serverSource = patch(serverSource, "clearTimeout(", `${R}.clearTimeout(`);
serverSource = patch(serverSource, "    setTimeout(() => {", `    ${R}.setTimeout(() => {`);
serverSource = patch(serverSource, "Bun.serve<WSData>(", `${R}.serve(`);
serverSource = patch(serverSource, "Bun.spawn(", `${R}.spawn(`);
serverSource = patch(serverSource, 'import("./term-summary")', `import(${JSON.stringify(join(root, "src/term-summary.ts"))})`);
serverSource +=
  "\nexport { renderTerminalBuffer, extractOsc7Cwd, scrubSecrets, spawnPty, sessionName, validateCwd, bufferPush, sessions, KOHO_ZDOTDIR };\n";
writeFileSync(join(work, "server.mjs"), transpiler.transformSync(serverSource));

/** What the stand-ins saw, in order, for the scenario being recorded. */
let effects: unknown[] = [];
const say = (...entry: unknown[]) => effects.push(entry);

// bun-pty's native library: one handle per spawn, its output what a scenario
// queues, its exit when a scenario says.
/** closed: killed, so that its read loop has stopped. */
type Handle = { queue: number[]; exited: boolean; reported: boolean; closed: boolean };
const handles: Handle[] = [];
// bun_pty_spawn fails for a program the stand-in has not got, and for a
// size that is not a finite number (as the real one does for NaN).
const spawnFails = (line: string, cols: number, rows: number) => line.includes("no-such") || !Number.isFinite(cols) || !Number.isFinite(rows);
/** Handles of earlier scenarios come first; a scenario's own count from here. */
let handleBase = 0;
const decodeArg = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\0$/, "");
const lib = {
  symbols: {
    bun_pty_spawn(cmdline: Uint8Array, cwd: Uint8Array, env: Uint8Array, cols: number, rows: number) {
      const line = decodeArg(cmdline);
      const envText = decodeArg(env);
      const pairs = envText
        .split("\0")
        .filter(Boolean)
        .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (spawnFails(line, cols, rows)) {
        say("spawn-failed", line);
        return -1;
      }
      handles.push({ queue: [], exited: false, reported: false, closed: false });
      say("spawn", handles.length - 1 - handleBase, line, decodeArg(cwd), num(cols), num(rows), pairs);
      return handles.length - 1;
    },
    bun_pty_write(handle: number, buf: Uint8Array, length: number) {
      say("pty-write", handle - handleBase, hex(buf.subarray(0, length)));
      return length;
    },
    bun_pty_read(handle: number, buf: Uint8Array, length: number) {
      const h = handles[handle];
      if (h.queue.length) {
        const n = Math.min(length, h.queue.length);
        buf.set(h.queue.splice(0, n));
        return n;
      }
      return h.exited ? -2 : 0;
    },
    bun_pty_resize(handle: number, cols: number, rows: number) {
      say("pty-resize", handle - handleBase, num(cols), num(rows));
      return 0;
    },
    bun_pty_kill(handle: number) {
      handles[handle].closed = true;
      say("pty-kill", handle - handleBase);
      return 0;
    },
    bun_pty_get_pid: () => 4242,
    bun_pty_get_exit_code(handle: number) {
      handles[handle].reported = true;
      return 0;
    },
    bun_pty_close: () => {},
  },
};

const record = {
  lib,
  terminals: [] as any[],
  ptyModule: {
    spawn(file: string, args: string[], opts: unknown) {
      const terminal = new Terminal(file, args, opts);
      record.terminals.push(terminal);
      return terminal;
    },
  },
  cwd: "/srv",
  sendResults: [] as number[],
  hostname: "parity-host",
  env: {} as Record<string, string>,
  existing: new Set<string>(),
  exists(path: string) {
    return record.existing.has(path);
  },
  mkdir(path: string) {
    say("mkdir", path);
    record.existing.add(path);
  },
  clock: 1_700_000_000_000,
  now: () => record.clock,
  timers: [] as { id: number; at: number; fn: () => void }[],
  nextTimer: 1,
  setTimeout(fn: () => void, ms: number) {
    const id = record.nextTimer++;
    record.timers.push({ id, at: record.clock + ms, fn });
    return id;
  },
  clearTimeout(id: number | undefined) {
    record.timers = record.timers.filter((t) => t.id !== id);
  },
  options: null as any,
  serve(options: any) {
    record.options = options;
    return fakeServer;
  },
  git: {} as Record<string, string>,
  spawn(argv: string[]) {
    say("git", argv.slice(3).join(" "), argv[2]);
    return { stdout: record.git[argv.slice(3).join(" ")] ?? "" };
  },
};
(globalThis as any).__wtxRecord = record;

let clientIp = "127.0.0.1";
let upgradeData: unknown = null;
const fakeServer = {
  port: 3004,
  requestIP: () => ({ address: clientIp, family: "IPv4", port: 50000 }),
  upgrade(req: Request, opts: { data: unknown }) {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return false;
    upgradeData = opts.data;
    return true;
  },
};

// console.log and console.error of the server, as effects.
const realLog = console.log;
const realError = console.error;
const captureConsole = () => {
  console.log = (...args: unknown[]) => say("stdout", args.map(String).join(" "));
  console.error = (...args: unknown[]) => say("stderr", args.map(String).join(" "));
};
const releaseConsole = () => {
  console.log = realLog;
  console.error = realError;
};

let instance = 0;
/** A fresh copy of the server module, with these variables as it is loaded. */
async function loadServer(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const mod = await import(`${join(work, "server.mjs")}?instance=${instance++}`);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return mod;
}
const server = await loadServer({ TERMINAL_WS_PORT: undefined, TERMINAL_ACCESS_KEY: undefined, WTX_REPO_BASE: undefined });
const { summarizeTerminal } = await import(join(root, "src/term-summary.ts"));

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** Until bun-pty's read loop has taken everything queued (and reported an exit). */
async function drain() {
  for (let i = 0; i < 500; i++) {
    // A loop that has stopped (killed, or after its program ended) takes nothing more.
    if (handles.every((h) => h.closed || h.reported || (h.queue.length === 0 && !h.exited))) return;
    await pause(2);
  }
  throw new Error("bun-pty's read loop did not take what was queued");
}

const fixtures: Record<string, Record<string, unknown>> = { js: {}, summary: {}, server: {}, scenarios: {} };

// ═══════════════════════════ js.json ═══════════════════════════

{
  const r = random(1);
  const SPACES = [" ", "\t", "\n", "\r", "\u000b", "\u000c", "\u00a0", "\u1680", "\u2000", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u0085", "\u180e", "\u200b"];
  fixtures.js.trim = Array.from({ length: 600 }, () => {
    const s = join_(r, [...SPACES, "a", "é", "😀", " b "], 6);
    return [s, s.trim(), s.trimEnd()];
  });
  const INT_PIECES = [...SPACES.slice(0, 8), "+", "-", "0x", "0X", "0", "1", "9", "a", "f", "F", "g", "12", "3004", "65535", "99999", ".", "5", "e", "1e3", "007", "123456789012345", "1234567890123456", "ffffffffffff", "x", "Infinity", "NaN", "٣", "１", "0b1", "0o7"];
  fixtures.js.parseInt = Array.from({ length: 1500 }, () => {
    const s = join_(r, INT_PIECES, 5);
    return [s, num(parseInt(s))];
  });
  const DOUBLES = [0, -0, 1, -1, 0.1, 0.5, 1.5, 2.5, 100.7, 30.2, 1e21, 1e-7, 1e-6, 123456789012345680000, 2 ** 53, 2 ** 53 + 2, 1 / 3, 2 / 3, Math.PI, 5e-324, 1.7976931348623157e308, 1e300, 0.000001234, 123e-20, NaN, Infinity, -Infinity, 9007199254740991, 1459077941253781.25, 4.35, 0.3];
  const numbers: number[] = [...DOUBLES];
  for (let i = 0; i < 1500; i++) {
    const kind = below(r, 4);
    if (kind === 0) numbers.push(below(r, 1e9) / pick(r, [1, 2, 4, 8, 10, 100, 1000, 3, 7]));
    else if (kind === 1) numbers.push(Number(`${below(r, 1e6)}e${below(r, 60) - 30}`));
    else if (kind === 2) numbers.push((r() - 0.5) * 10 ** (below(r, 40) - 20));
    else {
      const view = new DataView(new ArrayBuffer(8));
      view.setUint32(0, Math.floor(r() * 2 ** 32));
      view.setUint32(4, Math.floor(r() * 2 ** 32));
      numbers.push(view.getFloat64(0));
    }
  }
  fixtures.js.numberToString = numbers.map((x) => [bits(x), String(x), JSON.stringify(x)]);
  const STRING_PIECES = ['"', "\\", "/", "\b", "\f", "\n", "\r", "\t", "\u0000", "\u0001", "\u001f", "\u007f", "\u0080", "\u2028", "\u2029", "é", "😀", "a", " ", "<", ">", "&", "'", "\ufeff", "\u00ad"];
  fixtures.js.jsonString = Array.from({ length: 600 }, () => {
    const s = join_(r, STRING_PIECES, 6);
    return [s, JSON.stringify(s)];
  });
  const URI_PIECES = ["%", "%2", "%20", "%25", "%2f", "%2F", "%C3%A9", "%c3%a9", "%E2%82%AC", "%F0%9F%98%80", "%C0%80", "%C2", "%ED%A0%80", "%F4%90%80%80", "%F4%8F%BF%BF", "%80", "%FF", "%E2%82", "%E0%A4%A", "a", "é", "+", "%2B", "%zz", "%%", "/", "?", "#", " ", "%00", "%F8%80%80%80%80", "%EF%BB%BF"];
  fixtures.js.decodeURIComponent = Array.from({ length: 1500 }, () => {
    const s = join_(r, URI_PIECES, 5);
    let decoded: string | null;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      decoded = null;
    }
    return [s, decoded];
  });
  const QUERY_PIECES = ["a", "b", "=", "&", "+", "%20", "%", "%zz", "%C3", "%A9", "é", "?", "key", "cwd", "/x", "%2F", "==", "&&", "%26", "%3D", "%FF", "%EF%BB%BF", " "];
  fixtures.js.searchParams = Array.from({ length: 1000 }, () => {
    const q = join_(r, QUERY_PIECES, 8);
    return [q, [...new URLSearchParams(q)]];
  });
  const BYTES = [0x41, 0x0a, 0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80, 0xff, 0xef, 0xbb, 0xbf, 0xed, 0xa0, 0xc0, 0xc2, 0xf4, 0x90, 0x8f, 0xe0];
  const randomBytes = (n: number) => Uint8Array.from({ length: n }, () => pick(r, BYTES));
  fixtures.js.textDecode = Array.from({ length: 1500 }, () => {
    const b = randomBytes(below(r, 10));
    return [hex(b), new TextDecoder().decode(b)];
  });
  fixtures.js.streamDecode = Array.from({ length: 1000 }, () => {
    const decoder = new TextDecoder("utf-8");
    const chunks = Array.from({ length: 1 + below(r, 4) }, () => randomBytes(below(r, 5)));
    const outputs = chunks.map((c) => decoder.decode(c, { stream: true }));
    return [chunks.map(hex), outputs, decoder.decode()];
  });
}

// ═══════════════════════════ summary.json ═══════════════════════════

{
  const r = random(2);
  const PIECES = [
    "⏺ ", "⏺", "⏺\t", "※ recap: ", "※recap:", "※  recap:", "recap:", "✻ Worked for ", "✻ Cogitated for ", "✻  worked  FOR  ", "✻ Worked for", "1m ", "12m  ", "5s", "05S",
    "3M ", "m ", "s", "esc to interrupt", "Actioning…", "Running…", "Running...", "(ctrl+b to run in background)", "Command running in background",
    "error", "Error:", "ERROR", "errors", "_error", "error_", "failed", "NOT_FOUND", "not_found", "exit code 1", "exit code 0", "exit code 12", "exit code 9!",
    " (disable recaps in /config)", "(disable recap in /config)", "(Disable Recaps In /Config)", "  ", "    ", "\t", "\u00a0", "\u3000", "\ufeff", "\u0085", "\r", "\u2028",
    "?", "？", "ください", "ください。", "教えてください", "と言ってください。", "⎿", "  ⎿ ", "❯", "❯ ", "x", "plain text", "_", "Ｅrror", "ſ", "\u212a",
    "12345678901234", "1234567890123456789", "§", "─────", "",
  ];
  const lineOf = () => join_(r, PIECES, 5);
  const screens: string[] = ["", "\n", "\n\n  \n", " ", "⏺ hello?", "※ recap: done", "✻ Worked for 1m 5s"];
  for (let i = 0; i < 1500; i++) {
    const count = below(r, 16) === 0 ? 70 + below(r, 40) : 1 + below(r, 12);
    const lines: string[] = [];
    for (let j = 0; j < count; j++) lines.push(below(r, 4) === 0 ? "" : lineOf());
    screens.push(lines.join("\n"));
  }
  fixtures.summary.screens = screens.map((s) => [s, JSON.stringify(summarizeTerminal(s))]);
}

// ═══════════════════════════ server.json ═══════════════════════════

{
  const r = random(3);
  const PATHS = ["/", "/tmp", "/home/u", "C:/", "c:\\", "C:\\Users\\x", "D:", "rel", "./x", "../x", "/a/../b", "/a/..", "/..", "/./", "\\\\server\\share", "/sp ace", "/é", "/😀", "", "/a//b", "/x/", "C:relative", "\\", "Z:/a\\b"];
  fixtures.server.sessionName = Array.from({ length: 300 }, () => {
    const cwd = join_(r, PATHS, 3);
    return [cwd, server.sessionName(cwd)];
  });
  const RAW: unknown[] = [null, "", 0, false];
  for (let i = 0; i < 600; i++) RAW.push(join_(r, PATHS, 3));
  fixtures.server.validateCwd = RAW.map((raw) => {
    effects = [];
    record.existing = new Set(["/", "/tmp", "C:/", "/home/u"]);
    try {
      const resolved = server.validateCwd(raw);
      return [raw, { ok: resolved, effects }];
    } catch (error) {
      return [raw, { error: (error as Error).message, effects }];
    }
  });
  const SIZES = [NaN, Infinity, -Infinity, 0, -5, 1, 2, 9.9, 10, 10.5, 24, 80, 80.9, 132, 1e308, -0];
  const sizeOf = () => ({ cols: pick(r, SIZES), rows: pick(r, SIZES) });
  fixtures.server.negotiateSize = Array.from({ length: 800 }, () => {
    const caps = Array.from({ length: below(r, 4) }, sizeOf);
    const current = sizeOf();
    const next = server.negotiateSize(caps, current);
    return [caps.map((c) => [bits(c.cols), bits(c.rows)]), [bits(current.cols), bits(current.rows)], [num(next.cols), num(next.rows)]];
  });
  const OSC = ["\x1b]7;file://", "\x1b]7;", "host", "/", "/a b", "%20", "%E0", "%C3%A9", "\x07", "\x1b\\", "\x1b", "]7;file://", "x", "\n", "\r", "\u2028", "é", "\x1b[c"];
  fixtures.server.extractOsc7Cwd = Array.from({ length: 1500 }, () => {
    let bytes = new TextEncoder().encode(join_(r, OSC, 7));
    if (below(r, 8) === 0) bytes = Uint8Array.from([...bytes, 0xff, ...bytes]);
    if (below(r, 12) === 0) bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes]);
    return [hex(bytes), server.extractOsc7Cwd(bytes)];
  });
  const NAMES = ["PATH", "HOME", "Path", "path", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_X", "lc_x", "XDG_A", "NODE_ENV", "npm_x", "NPM_X", "BUN_X", "PNPM_X", "YARN_X", "GIT_X", "VSCODE_X", "TERMINFO", "TERMINFO_DIRS", "SSH_X", "SSH_AUTH_SOCK", "HOST", "HOSTNAME", "ZDOTDIR", "PROMPT_COMMAND", "GH_TOKEN", "OPENAI_API_KEY", "SECRET", "TERMINAL_ACCESS_KEY", "SystemRoot", "SYSTEMROOT", "ProgramFiles(x86)", "CODEHOST", "X", "LC_", "XDG", "1", "__proto__", "constructor", "toString"];
  const VALUES = ["", "v", "a b", "é", "=", "x=y", "$PWD", "'", '"', "\\", "echo hi"];
  fixtures.server.ptyEnv = Array.from({ length: 150 }, () => {
    const env: Record<string, string> = {};
    for (let n = below(r, 10); n > 0; n--) env[pick(r, NAMES)] = pick(r, VALUES);
    record.env = env;
    effects = [];
    captureConsole();
    try {
      const cmd = [pick(r, ["bash", "/bin/zsh", "a b", "it's"]), ...Array.from({ length: below(r, 3) }, () => pick(r, ["-l", "", "x y", "'q'", "é"]))];
      const pty = server.spawnPty(cmd, [], pick(r, [80, 10, 100.5]), pick(r, [24, 2]), pick(r, ["/tmp", "/a b", "C:/x"]));
      pty.kill();
      return [Object.entries(env), cmd, effects];
    } finally {
      releaseConsole();
    }
  });
  fixtures.server.bufferPush = Array.from({ length: 200 }, () => {
    const session = { buffer: [] as Uint8Array[], bufferBytes: 0 };
    const sizes = Array.from({ length: 1 + below(r, 8) }, () => pick(r, [0, 1, 100, 300_000, 524_288, 1_048_575, 1_048_576, 1_048_577, 2_000_000]));
    const after = sizes.map((size) => {
      server.bufferPush(session, new Uint8Array(size));
      return [session.bufferBytes, session.buffer.map((c: Uint8Array) => c.length)];
    });
    return [sizes, after];
  });
  const CWDS = ["/r/o/p", "/r/o/p/sub", "/r/o/pp", "/r/o", "/r/o/p/", "/x", "", "/r/o/p%20q", "/r/o/p q"];
  fixtures.server.statusForRepo = Array.from({ length: 300 }, () => {
    server.sessions.clear();
    const list = Array.from({ length: below(r, 4) }, (_, i) => ({ key: `k${i}`, cwd: pick(r, CWDS), lastActivity: record.clock - pick(r, [0, 1, 59_999, 60_000, 60_001, 3_600_000]) }));
    for (const s of list) server.sessions.set(s.key, s);
    const folder = pick(r, ["/r/o/p", "/r/o", "/r/o/p/sub", "/r/o/p%20q", "", "/"]);
    return [list.map((s) => [s.cwd, s.lastActivity]), record.clock, folder, JSON.stringify(server.getTerminalStatusForRepo(folder))];
  });
  const summaryOf: unknown[] = [];
  for (let i = 0; i < 300; i++) {
    server.sessions.clear();
    const list = Array.from({ length: below(r, 4) }, (_, j) => ({ key: `k${j}`, cwd: pick(r, CWDS), lastActivity: record.clock, buffer: [], cols: 80, rows: 24 }));
    for (const s of list) server.sessions.set(s.key, s);
    const cwd = pick(r, ["/r/o/p", "/r/o", "/r/o/p/sub", "/r/o/p/", "/r", "/x", "/r/o/p%20q"]);
    const result = await server.getTermSummaryForCwd(cwd);
    summaryOf.push([list.map((s) => s.cwd), cwd, result ? result.sessionKey : null]);
  }
  fixtures.server.summarySession = summaryOf;
  server.sessions.clear();
  const RENDER = ["a", "b", "\n", "\r\n", "\x1b[31m", "\x1b[0m", "\x1b]0;title\x07", "\x1b]7;file://h/x\x1b\\", "\x1b(B", "\x1bM", "\x07", "\x00", "\x7f", "\t", "\x1b[?25l", "é", "line\n", "\n\n", "\x1b"];
  const rendered: unknown[] = [];
  for (let i = 0; i < 400; i++) {
    let bytes = new TextEncoder().encode(join_(r, RENDER, 10));
    if (below(r, 10) === 0) bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes, 0xff]);
    const tail = pick(r, [0, 0, 1, 2, 5]);
    const offset = pick(r, [0, 0, 1, 3]);
    rendered.push([hex(bytes), tail, offset, await server.renderTerminalBuffer(bytes, 80, 24, tail, offset)]);
  }
  fixtures.server.renderFallback = rendered;
  fixtures.server.zshrc = ["koho-term-zshrc", ...[".zshenv", ".zprofile", ".zshrc"].map((name) => [name, readFileSync(join(server.KOHO_ZDOTDIR, name), "utf8")])];
}

// ═══════════════════════════ scenarios.json ═══════════════════════════
//
// The handlers themselves: a fresh copy of the module per scenario, its
// fetch and websocket handlers called with events made up as it goes (from
// what the scenario has so far: sessions, clients, PTYs), and every effect
// of each event recorded in order. bun-pty's Terminal runs as it is, its
// read loop taking what an event queues as its program's output.

{
  const r = random(4);
  // JSON.parse and Number(), which the handlers apply to bodies and messages.
  const JSON_PIECES = ["{", "}", "[", "]", ",", ":", '"a"', '"cmd"', '"cols"', "1", "-0", "1e400", "0.5", "true", "null", '"\\u00e9"', '"\\ud83d\\ude00"', '"\\ud800"', " ", "\n", '"x', "01", "-", "1.", ".5", "\"\\q\""];
  fixtures.js.jsonParse = Array.from({ length: 1500 }, () => {
    const text = join_(r, JSON_PIECES, 6);
    let out: unknown;
    try {
      out = JSON.stringify(JSON.parse(text));
    } catch {
      out = null;
    }
    return [text, out];
  });
  const NUMBER_PIECES = [" ", "\t", "\u00a0", "\ufeff", "\n", "+", "-", "0x", "0X", "0o", "0b", "1", "9", "f", "e", "E", ".", "Infinity", "NaN", "1e", "12", "0", "ffffffffffffffff", "_", "١"];
  fixtures.js.toNumber = Array.from({ length: 1500 }, () => {
    const text = join_(r, NUMBER_PIECES, 5);
    return [text, num(Number(text))];
  });

  const KEYS = ["a", "b", "a%20b", "%C3%A9", "%ZZ", "s_x"];
  const BODIES: (string | null)[] = [
    null, "", "hello", "null", "[]", "7", '"x"', "{}",
    '{"cmd":["<P>","-l"]}', '{"cmd":["<P>"],"cols":120,"rows":40}', '{"cmd":[]}', '{"cmd":"ls"}', '{"cmd":[1]}',
    '{"cwd":"/r/o/p/sub"}', '{"cwd":"rel"}', '{"cwd":"/r/../x"}', '{"cwd":""}', '{"cwd":0}', '{"cwd":5}', '{"cwd":"C:\\\\w"}', '{"cwd":null}',
    '{"cols":3,"rows":1}', '{"cols":"100","rows":"30"}', '{"cols":100.7,"rows":30.2}', '{"cols":"abc"}', '{"cols":true}', '{"cols":[5]}', '{"cols":null,"rows":null}', '{"cols":1e400}',
    '{"cmd":["/bin/no-such"]}', '{"cmd":["<P>"],"cmd":["<P>","x"]}', '{"__proto__":1,"cmd":["<P>"]}', '{"cmd":["\\ud800"]}',
  ];
  const PROGRAMS = ["bash", "/bin/sh", "a b", "it's", "é"];
  const QUERIES = ["", "?tail=1", "?tail=0", "?tail=abc", "?strip=1", "?offset=2", "?cr=1", "?cr=0", "?key=k", "?key=x", "?cwd=/r/o/p", "?cwd=/r", "?cwd=", "?x=1&cr=1"];
  const WS_QUERIES = ["?cwd=/r/o/p", "?cwd=/srv/new", "?cwd=rel", "?cwd=", "", "?session=a", "?session=b", "?session=", "?session=a&cwd=rel", "?cwd=/r/o/p&cols=100&rows=30", "?cwd=/r/o/p&cols=4&rows=1", "?cwd=/r/o/p&cols=abc", "?cwd=/r/o/p&cols=99999999999999999999", "?cwd=/r/o/p&key=k", "?cwd=/r/o/p%20q"];
  const MESSAGES = [
    '{"type":"resize","cols":100,"rows":30}', '{"type":"resize","cols":"90","rows":20.9}', '{"type":"resize","cols":1,"rows":1}', '{"type":"resize","cols":0,"rows":5}',
    '{"type":"resize","cols":"x","rows":5}', '{"type":"resize","cols":[5],"rows":5}', '{"type":"resize","cols":true,"rows":3}',
    '{"type":"ping","t":42}', '{"type":"ping","t":"x"}', '{"type":"ping","t":null}', '{"type":"ping"}', '{"type":"ping","t":-0}', '{"type":"ping","t":1.5e300}', '{"type":"ping","t":[1]}', '{"type":"ping","t":true}',
    '{"type":"other"}', "ls\r", "null", "5", "not json {", '"str"', "", "é\r",
  ];
  const OUTPUT = ["hello\r\n", "x", "\x1b]7;file://h/r/o/p/sub\x07", "\x1b]7;file://h/r/o/p%20q\x1b\\", "\x1b]7;file://h/srv\x07", "\x1b[c", "\x1b[0c", "\x1b[6n", "\xe2\x82", "\xac", "\xff", "\xef\xbb\xbf", "\x1b[31mred\x1b[0m", "\r\n"];
  const bytesOf = (pieces: string) => Uint8Array.from(pieces, (c) => c.charCodeAt(0));
  const GIT: Record<string, string> = {
    "branch --show-current": "main\n",
    "status --porcelain": " M a\nM  b\n?? c\nR  d -> e\n",
    "rev-list --left-right --count @{u}...HEAD": "1\t2\n",
  };
  const latin1 = (s: string) => Buffer.from(bytesOf(s));

  const scenarios: unknown[] = [];
  for (let n = 0; n < 200; n++) {
    const config = { TERMINAL_ACCESS_KEY: pick(r, [undefined, undefined, "k"]), WTX_REPO_BASE: pick(r, [undefined, "/r"]) };
    const mod = await loadServer({ ...config, TERMINAL_WS_PORT: undefined });
    record.options = null;
    effects = [];
    captureConsole();
    try {
      mod.startTerminalWS();
    } finally {
      releaseConsole();
    }
    const startUp = effects;
    const options = record.options;
    handleBase = handles.length;
    record.timers = [];
    record.clock = 1_700_000_000_000;
    record.existing = new Set(["/", "/srv", "/r", "/r/o/p"]);
    record.git = GIT;
    record.sendResults = [];
    record.env = { PATH: "/usr/bin", HOME: "/home/u", SECRET: "s", LC_X: "1" };
    for (const [name, value] of [["SHELL", pick(r, ["/bin/sh", "", undefined, "/bin/zsh"])], ["WTX_DEFAULT_CWD", pick(r, [undefined, undefined, "/w", "rel", ""])], ["PROMPT_COMMAND", pick(r, [undefined, "pc"])]] as const) {
      if (value !== undefined) record.env[name] = value;
    }
    record.cwd = pick(r, ["/srv", "/r/o/p"]);
    const startEnv = { ...record.env };
    const sockets: any[] = [];
    const events: unknown[] = [];
    const count = 4 + below(r, 26);
    // After a change to what ws.send returns, output with an OSC 7 follows,
    // which is where the server looks at that value.
    let backedUp = false;
    for (let e = 0; e < count; e++) {
      effects = [];
      captureConsole();
      let event: Record<string, unknown> = {};
      try {
        const roll = r();
        const ptyCount = handles.length - handleBase;
        if (roll < 0.36 || (roll < 0.5 && sockets.length === 0)) {
          // An HTTP request (or the handshake of a WebSocket).
          const websocket = r() < 0.3;
          // Half the time a key the scenario has a session for.
          const live = [...mod.sessions.keys()];
          const key = live.length && r() < 0.5 ? encodeURIComponent(pick(r, live)) : pick(r, KEYS);
          const typing = !websocket && live.length > 0 && r() < 0.2;
          const method = websocket ? "GET" : typing ? "POST" : pick(r, ["GET", "GET", "POST", "POST", "DELETE", "PUT"]);
          const target = websocket
            ? `${pick(r, ["/", "/", "/x"])}${live.length && r() < 0.3 ? `?session=${key}` : pick(r, WS_QUERIES)}`
            : typing
              ? `/sessions/${key}/input${pick(r, ["", "?cr=1", "?cr=0", "?cr=1&cr=0"])}`
              : `${pick(r, ["/sessions", `/sessions/${key}`, `/sessions/${key}/buffer`, `/sessions/${key}/input`, `/sessions/${key}/git`, `/sessions/${key}/x`, "/status/o/p", "/status/o", "/summary", "/", "/x/../sessions"])}${pick(r, QUERIES)}`;
          const bodyText = typing ? pick(r, ["ls", "", "é", "\ufeffx", "a\r"]) : method === "POST" || method === "DELETE" ? pick(r, BODIES) : null;
          const body = bodyText === null ? null : bodyText.replaceAll("<P>", pick(r, PROGRAMS));
          const headers: Record<string, string> = {};
          const auth = pick(r, [undefined, undefined, "Bearer k", "Bearer x", "bearer k", "Basic k"]);
          if (auth) headers.authorization = auth;
          if (websocket) headers.upgrade = "websocket";
          clientIp = pick(r, ["127.0.0.1", "127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.2"]);
          const request = new Request(`http://127.0.0.1:3004${target}`, { method, headers, body: body ?? undefined });
          const url = new URL(request.url);
          event = { http: { method, pathname: url.pathname, search: url.search, authorization: request.headers.get("authorization"), websocket, body: body === null ? null : hex(new TextEncoder().encode(body)), ip: clientIp } };
          upgradeData = null;
          let outcome: unknown;
          try {
            const response = await options.fetch(request, fakeServer);
            if (response === undefined && upgradeData) {
              const id = sockets.length;
              const ws = {
                data: upgradeData,
                send(x: string | Uint8Array) {
                  say("send", id, typeof x === "string" ? "text" : "binary", typeof x === "string" ? x : hex(x));
                  return record.sendResults[id] ?? 1;
                },
                close(code: number, reason: string) {
                  say("close", id, code, reason);
                },
              };
              sockets.push(ws);
              outcome = { upgrade: id, fetchEffects: effects };
              effects = [];
              try {
                options.websocket.open(ws);
                await drain();
              } catch (error) {
                (outcome as any).openThrows = (error as Error).message;
              }
            } else {
              // A Response of a string has no Content-Type until Bun.serve sends it
              // (text/plain;charset=utf-8, as the parity cases show): null here.
              outcome = { status: response.status, type: response.headers.get("content-type"), body: hex(new Uint8Array(await response.arrayBuffer())) };
            }
          } catch (error) {
            outcome = { throws: (error as Error).message };
          }
          event.outcome = outcome;
        } else if (roll < 0.56 && sockets.length) {
          const id = below(r, sockets.length);
          const binary = r() < 0.15;
          const message = binary ? pick(r, ["61ff62", "efbbbf6869", "e282"]) : pick(r, MESSAGES);
          event = { message: { client: id, ...(binary ? { hex: message } : { text: message }) } };
          try {
            options.websocket.message(sockets[id], binary ? Buffer.from(message, "hex") : message);
            await drain();
          } catch (error) {
            event.throws = (error as Error).message;
          }
        } else if (roll < 0.61 && sockets.length) {
          const id = below(r, sockets.length);
          event = { close: id };
          options.websocket.close(sockets[id], 1000, "");
        } else if ((roll < 0.78 || backedUp) && ptyCount) {
          const pty = below(r, ptyCount);
          const big = below(r, 30) === 0;
          const data = backedUp ? `out\x1b]7;file://h/r/o/p/${pick(r, ["a", "b", "c"])}\x07` : big ? "y".repeat(5000) + "\x1b[c" : join_(r, OUTPUT, 4);
          event = { data: { pty, hex: hex(bytesOf(data)) } };
          handles[handleBase + pty].queue.push(...bytesOf(data));
          await drain();
        } else if (roll < 0.82 && ptyCount) {
          const pty = below(r, ptyCount);
          event = { exit: pty };
          handles[handleBase + pty].exited = true;
          await drain();
        } else if (roll < 0.94) {
          const ms = pick(r, [10, 49, 50, 51, 60, 1000, 60_001]);
          event = { advance: ms };
          record.clock += ms;
          for (;;) {
            const due = record.timers.filter((t) => t.at <= record.clock).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!due) break;
            record.timers = record.timers.filter((t) => t !== due);
            due.fn();
          }
          await drain();
        } else if (roll < 0.98 && sockets.length) {
          const id = below(r, sockets.length);
          const value = pick(r, [-1, 0, 1, 7]);
          event = { sendResult: { client: id, value } };
          record.sendResults[id] = value;
        } else {
          const name = pick(r, ["SHELL", "WTX_DEFAULT_CWD", "PROMPT_COMMAND"]);
          const value = pick(r, [undefined, "", "/bin/bash", "/srv/d", "x"]);
          event = { env: { name, value: value ?? null } };
          if (value === undefined) delete record.env[name];
          else record.env[name] = value;
        }
      } finally {
        releaseConsole();
      }
      event.effects = effects;
      backedUp = "sendResult" in event;
      events.push(event);
    }
    // The scenario's PTYs stop reading; the next scenario has fresh ones.
    // (What that does is not part of the scenario.)
    effects = [];
    captureConsole();
    for (const terminal of record.terminals) terminal.kill();
    releaseConsole();
    record.terminals = [];
    await pause(10);
    scenarios.push({ config: { accessKey: config.TERMINAL_ACCESS_KEY ?? "", repoBase: config.WTX_REPO_BASE ?? "" }, startUp, start: { env: startEnv, cwd: record.cwd }, events });
    void latin1;
  }
  fixtures.scenarios = { scenarios };
}


// ═══════════════════════════ write ═══════════════════════════

let stale = 0;
for (const [name, value] of Object.entries(fixtures)) {
  const file = join(testdata, `${name}.json`);
  // The directory of this run is written <ZDOTDIR>, the same on every system.
  const zdotdir = JSON.stringify(join(work, "koho-term-zshrc")).slice(1, -1);
  const text = JSON.stringify(value).split(zdotdir).join("<ZDOTDIR>") + "\n";
  if (check) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      console.error(`rs/src/testdata/${name}.json is not what this bun (${Bun.version}) records; run \`bun rs/parity/record.ts\``);
      stale++;
    }
  } else writeFileSync(file, text);
}
rmSync(work, { recursive: true, force: true });
if (stale) process.exit(1);
console.error(check ? `rs/src/testdata is what bun ${Bun.version} records` : `recorded rs/src/testdata with bun ${Bun.version}`);
process.exit(0);
