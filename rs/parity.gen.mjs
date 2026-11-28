#!/usr/bin/env node
// Writes rs/parity.json, the parity cases for wtx (Rust against TypeScript).
//
//   node rs/parity.gen.mjs           # rewrite rs/parity.json
//   node rs/parity.gen.mjs --check   # fail if rs/parity.json is not what this writes
//   node rs/parity.gen.mjs --list    # the case names, and where each is skipped
//
// Then, from the repository root, after `bun install` and a release build:
//
//   sh rs/parity/proof.sh <rustify>/templates/parity/parity.mjs rs/target/release/wtx
//
// wtx takes no arguments and starts a terminal server that runs until it is
// stopped. So every case runs rs/parity/drive.mjs in front of the
// implementation: it starts the server on 127.0.0.1 and a free port, drives
// it over HTTP and WebSocket with the case's steps (PARITY_STEPS), stops it,
// and prints every answer, every frame, how the server ended and all it
// logged (see the script). Sessions run a fixed program: bun with a script
// (`<BUN> -e …`), or, where wtx starts $SHELL itself, rs/parity/fake-shell.sh
// copied to <ROOT>/fake-shell.
//
// Who answers. The binary hands every invocation back to wtx.mjs, on every
// system: the server is one process, and it cannot hand a request back once
// it is listening. A Rust server would have to answer every request as
// Bun.serve and wtx do, and it cannot yet: the text of a session's screen
// (?strip=1, tail, offset, /summary) is rendered by @xterm/headless, and
// many requests are answered in bun's own words (a development error page
// with the stack, for a body of `null`, a key that is not valid
// percent-encoding, `cols` that is not a number, a command that does not
// exist). So every case is marked "handback", and the --handback check
// proves that the binary sends each of them to the JavaScript; the plain run
// proves that it does so without changing what users see. What is ported is
// tested beside it, as Rust modules against outputs recorded from the
// TypeScript (rs/src/testdata, rs/parity/record.ts).
//
// That includes the runs that rustify's npm launcher starts under bun (the
// first after an install, and every run where it cannot link): the "v-install"
// cases here, and rs/parity/launcher.mjs, which installs the package for real
// with bun and npm on every system and shows the one thing such a run does
// that wtx.mjs does not: a preload of bunfig.toml or BUN_OPTIONS runs once
// more, in the launcher.
//
// Every case has its own empty HOME and temp directory (the runner's), and
// TMPDIR there holds the koho-term-zshrc directory wtx writes at start-up.
// No case reaches the network: the server listens on 127.0.0.1 (or fails to
// listen; the two cases of a host that listens on every interface give it an
// access key made for the run, so that only loopback gets in), and git only
// ever works on repositories inside the case.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "parity.json");
const flags = new Set(process.argv.slice(2));

const BACK = "the binary hands every invocation back to wtx.mjs: the server is one process, and no part of it is ported (rs/src/main.rs)";
const cases = [];

/**
 * One case: `steps` for rs/parity/drive.mjs. `o.env`, `o.files`, `o.setup`,
 * `o.after`, `o.args` as the runner reads them; `o.shell` copies the fake
 * shell to <ROOT>/fake-shell and makes it $SHELL; `o.skip` per system.
 */
function add(name, steps, o = {}) {
  if (cases.some((c) => c.name === name)) throw new Error(`two cases named ${JSON.stringify(name)}`);
  const env = { PARITY_STEPS: JSON.stringify(steps), ...(o.shell ? { SHELL: "<ROOT>/fake-shell" } : {}), ...(o.env || {}) };
  const setup = [...(o.shell ? ['cp "<REPO>/rs/parity/fake-shell.sh" "<ROOT>/fake-shell" && chmod +x "<ROOT>/fake-shell"'] : []), ...(o.setup || [])];
  const testCase = { name, args: o.args || [], env };
  if (o.files) testCase.files = o.files;
  if (setup.length) testCase.setup = setup;
  if (o.after) testCase.after = o.after;
  if (o.timeout) testCase.timeout = o.timeout;
  if (o.skip) testCase.skip = o.skip;
  testCase.handback = BACK;
  cases.push(testCase);
}

// ── sessions that run a fixed program ───────────────────────────────────────

const BUN = "<BUN>";
/** bun running a script, kept alive (for at most 30 s) after the script's own work. */
const bunScript = (js) => [BUN, "-e", `${js}; setTimeout(() => {}, 30000)`];
/** A program that prints its stdin, line by line as the terminal delivers it, in hex. */
const ECHO = "process.stdin.on('data', (d) => process.stdout.write('got ' + Buffer.from(d).toString('hex') + '\\n')); process.stdout.write('ready\\n')";
/** The same with the terminal in raw mode: every byte as it comes. */
const RAW = "process.stdin.setRawMode(true); " + ECHO;
const create = (key, js, extra = {}) => ({ http: `POST /sessions/${key}`, body: { cmd: bunScript(js), ...extra } });
/** Waits until the session's buffer holds the text. A case waits for the whole of what a program
 *  prints before it lists the sessions (bufferBytes) or attaches (how output is cut into chunks
 *  decides which frames come before replay-end). */
const wait = (key, text) => ({ wait: key, contains: text });
/** A script that prints `js`, a JavaScript string literal's content (`hello\\n` prints a line). */
const say = (js) => `process.stdout.write("${js}")`;
/** A script that prints nothing, for sessions whose output does not matter. */
const QUIET = "void 0";

const LIST = { http: "GET /sessions" };

// ═══════════════════════════ start-up ═══════════════════════════

add("start: no arguments: it listens, with no sessions", [LIST]);
add("start: --help starts the server like no arguments", [LIST], { args: ["--help"] });
add("start: --version starts the server like no arguments", [LIST], { args: ["--version"] });
add("start: any words start the server like no arguments", [LIST], { args: ["serve", "-p", "1", "--", "x"] });
add("start: WTX_NO_NATIVE=1 changes nothing", [LIST], { env: { WTX_NO_NATIVE: "1" } });
add("start: TERMINAL_WS_PORT out of range (bun's error, exit 1)", [], { env: { TERMINAL_WS_PORT: "99999" } });
add("start: TERMINAL_WS_PORT negative", [], { env: { TERMINAL_WS_PORT: "-1" } });
add("start: TERMINAL_WS_PORT empty is NaN", [], { env: { TERMINAL_WS_PORT: "" } });
add("start: TERMINAL_WS_PORT not a number", [], { env: { TERMINAL_WS_PORT: "port" } });
add("start: TERMINAL_WS_PORT with letters after the number (parseInt)", [LIST], { env: { TERMINAL_WS_PORT: "{PORT}abc" } });
add("start: TERMINAL_WS_PORT with white space and a sign before it", [LIST], { env: { TERMINAL_WS_PORT: " \t+{PORT}" } });
add("start: TERMINAL_WS_PORT with a fraction", [LIST], { env: { TERMINAL_WS_PORT: "{PORT}.9" } });
add("start: the port is in use", [{ busy: true }]);
add("start: TERMINAL_WS_HOST an address this machine does not have", [], { env: { TERMINAL_WS_HOST: "192.0.2.1" } });
// These two listen on every interface: a key of the run's own keeps out
// whoever else could reach the port meanwhile (loopback needs none).
const OPEN = { TERMINAL_ACCESS_KEY: "{SECRET}" };
add("start: TERMINAL_WS_HOST empty", [LIST], { env: { TERMINAL_WS_HOST: "", ...OPEN } });
add("start: TERMINAL_WS_HOST 0.0.0.0", [LIST], { env: { TERMINAL_WS_HOST: "0.0.0.0", ...OPEN } });
add("start: TERMINAL_WS_HOST not an address", [], { env: { TERMINAL_WS_HOST: "not a host name" } });
const ZSH = ['cd "$TMPDIR/koho-term-zshrc" && for f in .zshenv .zprofile .zshrc; do echo "== $f"; cat "$f"; done; ls -A'];
add("start: writes the zsh start-up files into the temp directory", [], { after: ZSH });
add("start: rewrites start-up files that are there already", [], {
  setup: ['mkdir -p "$TMPDIR/koho-term-zshrc" && echo old > "$TMPDIR/koho-term-zshrc/.zshrc" && echo keep > "$TMPDIR/koho-term-zshrc/other"'],
  after: ZSH,
});
add("start: the temp directory is a file (mkdir fails before it listens)", [], {
  env: { TMPDIR: "<ROOT>/not-a-directory" },
  setup: ['echo x > "<ROOT>/not-a-directory"'],
  skip: { win32: "bun on Windows takes its temp directory from TEMP, which the runner sets for every case; a TEMP it cannot use makes it hang" },
});

// ═══════════════════════════ HTTP routes ═══════════════════════════

add("http: /sessions answers any method", [{ http: "POST /sessions" }, { http: "DELETE /sessions" }, { http: "PUT /sessions" }, { http: "GET /sessions?x=1" }, { http: "HEAD /sessions" }]);
add("http: other paths and methods want a WebSocket (426)", [
  { http: "GET /" },
  { http: "GET /nothing" },
  { http: "GET /sessions/" },
  { http: "GET //sessions" },
  { http: "GET /sessions/k" },
  { http: "PUT /sessions/k" },
  { http: "PATCH /sessions/k" },
  { http: "GET /sessions/k/input" },
  { http: "POST /sessions/k/git" },
  { http: "GET /sessions/k/other" },
  { http: "GET /sessions%2Fk/buffer" },
  { http: "GET /status/a" },
  { http: "GET /status/a/b/c" },
]);
add("http: the path is resolved as a URL (dot segments)", [{ http: "GET /x/../sessions" }, { http: "GET /./sessions" }, { http: "GET /sessions/k/../../sessions" }]);
add("http: unknown session keys", [
  { http: "GET /sessions/nope/buffer" },
  { http: "GET /sessions/nope/git" },
  { http: "POST /sessions/nope/input", body: "x" },
  { http: "DELETE /sessions/nope" },
]);
add("http: a key that is not valid percent-encoding (bun's error page)", [{ http: "DELETE /sessions/%ZZ" }, { http: "GET /sessions/%E0%A4%A/git" }, LIST]);
add("http: /summary without a cwd, and for a directory without a session", [{ http: "GET /summary" }, { http: "GET /summary?cwd=" }, { http: "GET /summary?cwd=<CWD>" }]);
add("http: /status without WTX_REPO_BASE", [{ http: "GET /status/owner/repo" }]);
add("http: bun's error page in production (NODE_ENV)", [{ http: "POST /sessions/k", body: "null" }, LIST], { env: { NODE_ENV: "production" } });

// ═══════════════════════════ POST /sessions/:key ═══════════════════════════

add("create: a session running a command, listed and read back", [
  create("one", say("hello\\n")),
  wait("one", "hello"),
  { http: "GET /sessions/one/buffer" },
  LIST,
]);
add("create: the key is URL-decoded, the buffer route takes it as written", [
  create("a%20b", say("x\\n")),
  { until: "log", contains: "created session a b" },
  { http: "GET /sessions/a%2520b/buffer" },
  { http: "GET /sessions/a b/buffer" },
  { http: "DELETE /sessions/a%2520b" },
  { http: "GET /sessions/a%20b/buffer" },
  { http: "DELETE /sessions/a%20b" },
  LIST,
]);
add("create: a key with UTF-8", [create("%C3%A9t%C3%A9", QUIET), LIST, { http: "DELETE /sessions/%C3%A9t%C3%A9" }]);
add("create: replacing a session kills the old one", [
  create("k", say("first\\n")),
  wait("k", "first"),
  create("k", say("second\\n")),
  wait("k", "second"),
  { http: "GET /sessions/k/buffer" },
  LIST,
]);
add("create: no body runs $SHELL in the server's directory", [{ http: "POST /sessions/sh" }, wait("sh", "fake shell"), { http: "GET /sessions/sh/buffer" }, LIST], { shell: true, skip: { win32: "$SHELL is a #! script, which Windows does not start" } });
add("create: a body that is not JSON counts as none", [{ http: "POST /sessions/sh", body: "hello" }, wait("sh", "fake shell"), LIST], { shell: true, skip: { win32: "$SHELL is a #! script, which Windows does not start" } });
add("create: an empty cmd, or one that is not a list, runs $SHELL", [
  { http: "POST /sessions/a", body: { cmd: [] } },
  { http: "POST /sessions/b", body: { cmd: "ls" } },
  { http: "POST /sessions/c", body: [] },
  { http: "POST /sessions/d", body: 7 },
  wait("a", "fake shell"),
  wait("b", "fake shell"),
  wait("c", "fake shell"),
  wait("d", "fake shell"),
  LIST,
], { shell: true, skip: { win32: "$SHELL is a #! script, which Windows does not start" } });
add("create: without SHELL it runs bash", [{ http: "POST /sessions/b" }], { env: { SHELL: null }, skip: { win32: "there is no bash on PATH for bun-pty on Windows" } });
add("create: a body of null (bun's error page)", [{ http: "POST /sessions/k", body: "null" }, LIST]);
add("create: a command that does not exist (bun's error page)", [{ http: "POST /sessions/k", body: { cmd: ["<ROOT>/no-such-program"] } }, LIST]);
add("create: cols and rows are clamped to 10 and 2", [create("k", QUIET, { cols: 3, rows: 1 }), LIST]);
add("create: cols and rows as given", [create("k", "process.stdout.write(process.stdout.columns + 'x' + process.stdout.rows + '\\n')", { cols: 132, rows: 43 }), wait("k", "\r\n"), { http: "GET /sessions/k/buffer" }, LIST]);
add("create: cols and rows that are strings of digits", [create("k", QUIET, { cols: "100", rows: "30" }), LIST]);
add("create: cols and rows with a fraction", [create("k", "process.stdout.write(process.stdout.columns + 'x' + process.stdout.rows + '\\n')", { cols: 100.7, rows: 30.2 }), wait("k", "\r\n"), { http: "GET /sessions/k/buffer" }, LIST]);
add("create: cols that is not a number (bun's error page)", [create("k", QUIET, { cols: "abc" }), LIST]);
add("create: cwd that does not exist is made", [create("k", QUIET, { cwd: "<CWD>/made/here" }), LIST], { after: ["ls -R made"] });
add("create: cwd with backslashes", [create("k", "process.stdout.write(process.cwd() + '.')", { cwd: "<CWD>\\sub" }), wait("k", "sub."), LIST], { after: ["ls"] });
add("create: cwd from WTX_DEFAULT_CWD", [create("k", "process.stdout.write(process.cwd() + '.')"), wait("k", "dflt."), LIST], { env: { WTX_DEFAULT_CWD: "<ROOT>/dflt" }, after: ['ls "<ROOT>/dflt" > /dev/null && echo made'] });
add("create: cwd ending in /.. is taken", [create("k", QUIET, { cwd: "<CWD>/.." }), LIST]);
add("create: cwd refused (relative, /../, empty, 0)", [
  create("k", QUIET, { cwd: "relative/dir" }),
  create("k", QUIET, { cwd: "<CWD>/../x" }),
  create("k", QUIET, { cwd: "" }),
  create("k", QUIET, { cwd: 0 }),
  create("k", QUIET, { cwd: "C:relative" }),
  LIST,
]);

// ═══════════════════════════ input, delete, buffer ═══════════════════════════

add("input: a body is typed into the session, ?cr=1 adds a carriage return", [
  create("k", ECHO),
  wait("k", "ready\r\n"),
  { http: "POST /sessions/k/input", body: "hello" },
  { http: "POST /sessions/k/input?cr=1", body: " world" },
  wait("k", "0a\r\n"),
  { http: "POST /sessions/k/input?cr=yes", body: "x" },
  { http: "POST /sessions/k/input", body: "\r" },
  wait("k", "got 780a\r\n"),
  { http: "GET /sessions/k/buffer" },
]);
add("input: bytes that are not UTF-8 arrive as U+FFFD", [
  create("k", RAW),
  wait("k", "ready\r\n"),
  { http: "POST /sessions/k/input", bodyHex: "61ff62c3" },
  wait("k", "bd\r\n"),
  { http: "GET /sessions/k/buffer" },
]);
add("delete: kills the session and forgets it", [
  create("k", say("x")),
  wait("k", "x"),
  { http: "DELETE /sessions/k" },
  { until: "log", contains: "PTY exited" },
  LIST,
  { http: "DELETE /sessions/k" },
]);
add("buffer: raw bytes, colours and CR LF", [create("k", say("a\\x1b[31mred\\x1b[0m\\tb\\n\\u00e9\\u2500\\n")), wait("k", "\u2500\r\n"), { http: "GET /sessions/k/buffer" }, { http: "GET /sessions/k/buffer?strip=0" }, { http: "GET /sessions/k/buffer?tail=0" }, { http: "GET /sessions/k/buffer?tail=-3" }, { http: "GET /sessions/k/buffer?tail=abc" }]);
const SCREEN = say("one\\ntwo \\x1b[1mbold\\x1b[0m\\nabc\\rX\\nfour   \\n\\n\\n");
add("buffer: the screen as text (?strip=1, tail, offset)", [
  create("k", SCREEN),
  wait("k", "four   \r\n\r\n\r\n"),
  { http: "GET /sessions/k/buffer?strip=1" },
  { http: "GET /sessions/k/buffer?tail=2" },
  { http: "GET /sessions/k/buffer?tail=2x" },
  { http: "GET /sessions/k/buffer?offset=1" },
  { http: "GET /sessions/k/buffer?tail=1&offset=2" },
  { http: "GET /sessions/k/buffer?offset=99" },
  { http: "GET /sessions/k/buffer?strip=1&tail=99" },
]);
add("buffer: a line longer than the terminal wraps on the screen", [create("k", say("0123456789abcdefghij\\n"), { cols: 10, rows: 5 }), wait("k", "j\r\n"), { http: "GET /sessions/k/buffer?strip=1" }]);

// ═══════════════════════════ git ═══════════════════════════

// GIT_CEILING_DIRECTORIES: "not a repository" must not find one above the case.
const GIT_ENV = { GIT_CEILING_DIRECTORIES: "<ROOT>", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@example.test", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
const REPO = ["git init -q -b main repo", "cd repo && echo a > a && echo b > b && git add a b && git commit -q -m one"];
const gitCase = (name, setup, cwd = "<CWD>/repo") =>
  add(`git: ${name}`, [create("g", QUIET, { cwd }), { http: "GET /sessions/g/git" }], { env: GIT_ENV, setup });
gitCase("a clean repository", REPO);
gitCase("staged, changed and untracked files", [...REPO, "cd repo && echo new > c && git add c && echo more >> b && echo u > untracked"]);
gitCase("a file changed only in the worktree, first in the list", [...REPO, "cd repo && echo more >> a"]);
gitCase("a deleted file and a rename", [...REPO, "cd repo && git rm -q b && git mv a moved"]);
gitCase("not a repository", []);
gitCase("ahead of and behind its upstream", [
  "git init -q --bare -b main store.git",
  "git clone -q store.git repo 2> /dev/null && cd repo && echo a > a && git add a && git commit -q -m one && git push -q -u origin main 2> /dev/null",
  "git clone -q store.git other 2> /dev/null && cd other && echo o > o && git add o && git commit -q -m theirs && git push -q origin main 2> /dev/null",
  "cd repo && echo m > m && git add m && git commit -q -m mine && git commit -q --allow-empty -m mine2 && git fetch -q",
]);
gitCase("a detached HEAD", [...REPO, "cd repo && git checkout -q --detach"]);

// ═══════════════════════════ /summary and /status ═══════════════════════════

const summary = (name, text, o = {}) =>
  add(`summary: ${name}`, [create("k", say(text), { cwd: o.cwd || "<CWD>" }), wait("k", o.marker || "§"), { http: `GET /summary?cwd=${o.query || "<CWD>"}` }]);
summary("the last line asks a question", "⏺ Shall I go on?§\\n");
summary("a recap line", "※ recap: all done (disable recaps in /config)§\\n");
summary("running, esc to interrupt", "✻ Thinking… (esc to interrupt)§\\n");
summary("time worked", "✻ Worked for 2m 5s§\\n");
summary("an error line", "Error: it failed§\\n");
summary("only the last line counts", "⏺ Shall I go on?\\nplain§\\n");
summary("a session in a directory below", "x§\\n", { cwd: "<CWD>/below" });
summary("a directory that only starts like the session's", "x§\\n", { cwd: "<CWD>/below", query: "<CWD>/bel" });
add("status: active, closed, and a repository whose name only starts the same", [
  create("k", QUIET, { cwd: "<ROOT>/repos/me/proj/sub" }),
  { http: "GET /status/me/proj" },
  { http: "GET /status/me/pro" },
  { http: "GET /status/me/other" },
  { http: "GET /status/me/proj%20x" },
], { env: { WTX_REPO_BASE: "<ROOT>/repos" } });
add("status: WTX_REPO_BASE from .env in the working directory (bun loads it)", [create("k", QUIET, { cwd: "<ROOT>/repos/me/proj" }), { http: "GET /status/me/proj" }], { files: { ".env": "WTX_REPO_BASE=<ROOT>/repos\n" } });
add("status: .env.local and the variable itself, which wins", [{ http: "GET /status/me/proj" }], { files: { ".env.local": "WTX_REPO_BASE=<ROOT>/from-file\n" }, env: { WTX_REPO_BASE: "" } });

// ═══════════════════════════ access key ═══════════════════════════

const OTHER = { from: "127.0.0.2" };
const NO_SECOND_LOOPBACK = { darwin: "macOS has no loopback address but 127.0.0.1 (a client from anywhere else needs a network)" };
add("access: with a key, a client from another address needs it", [
  { http: "GET /sessions", ...OTHER },
  { http: "GET /sessions", ...OTHER, headers: { Authorization: "Bearer sekrit" } },
  { http: "GET /sessions?key=sekrit", ...OTHER },
  { http: "GET /sessions?key=wrong", ...OTHER },
  { http: "GET /sessions?key=sekrit", ...OTHER, headers: { Authorization: "Bearer wrong" } },
  { http: "GET /sessions?key=sekrit", ...OTHER, headers: { Authorization: "bearer sekrit" } },
  { http: "GET /sessions", ...OTHER, headers: { Authorization: "Basic sekrit" } },
  { http: "GET /sessions" },
  { http: "GET /nothing", ...OTHER },
], { env: { TERMINAL_ACCESS_KEY: "sekrit" }, skip: NO_SECOND_LOOPBACK });
add("access: without a key nothing is checked", [{ http: "GET /sessions", ...OTHER }], { skip: NO_SECOND_LOOPBACK });
add("access: the key from .env", [{ http: "GET /sessions", ...OTHER }, { http: "GET /sessions?key=from-file", ...OTHER }], { files: { ".env": "TERMINAL_ACCESS_KEY=from-file\n" }, skip: NO_SECOND_LOOPBACK });
add("access: a WebSocket from another address without the key", [{ ws: "?session=x", ...OTHER }, { ws: "?session=x&key=sekrit", name: "b", ...OTHER }, { recv: "b", until: "close" }], { env: { TERMINAL_ACCESS_KEY: "sekrit" }, skip: NO_SECOND_LOOPBACK });

// ═══════════════════════════ WebSocket ═══════════════════════════

const NO_SH = { win32: "$SHELL is a #! script, which Windows does not start" };
const attach = (query = "?cwd=<CWD>", name = "a") => [{ ws: query, name }, { recv: name, until: { type: "replay-end" } }];
add("ws: attach by directory starts $SHELL there", [...attach(), { recv: "a", until: { text: "fake shell" } }, LIST], { shell: true, skip: NO_SH });
add("ws: a second client gets the replay", [...attach(), { recv: "a", until: { text: "fake shell" } }, ...attach("?cwd=<CWD>", "b"), { recv: "b", until: { quiet: 300 } }, LIST], { shell: true, skip: NO_SH });
add("ws: refused directories (missing, relative, /../)", [
  { ws: "" }, { recv: "a", until: "close" },
  { ws: "?cwd=", name: "b" }, { recv: "b", until: "close" },
  { ws: "?cwd=rel", name: "c" }, { recv: "c", until: "close" },
  { ws: "?cwd=<CWD>/../x", name: "d" }, { recv: "d", until: "close" },
  LIST,
]);
add("ws: a directory that does not exist is made", [...attach("?cwd=<CWD>/new/dir"), { recv: "a", until: { text: "fake shell" } }], { shell: true, skip: NO_SH, after: ["ls -R new"] });
add("ws: any path takes a WebSocket", [...attach("?cwd=<CWD>").map((s) => (s.ws !== undefined ? { ...s, path: "/some/where" } : s)), { recv: "a", until: { text: "fake shell" } }], { shell: true, skip: NO_SH });
add("ws: an unknown session", [{ ws: "?session=nope" }, { recv: "a", until: "close" }, LIST]);
add("ws: an empty session name attaches by directory", [...attach("?session=&cwd=<CWD>"), { recv: "a", until: { text: "fake shell" } }], { shell: true, skip: NO_SH });
add("ws: attach to a named session, whatever its directory", [create("k", say("named\\n")), wait("k", "named\r\n"), ...attach("?session=k&cwd=rel"), { recv: "a", until: { quiet: 300 } }, LIST]);
add("ws: cols and rows from the query, clamped", [...attach("?cwd=<CWD>&cols=4&rows=1"), { recv: "a", until: { text: "fake shell" } }, { send: "a", text: "size\r" }, { recv: "a", until: { text: "size 2 10" } }, LIST], { shell: true, skip: NO_SH });
// The server ends here (exit 1). On one run on macOS the driver saw that end
// before the last step was done with wtx.mjs, and only after it, while it
// waited for the server's log to be quiet, with the binary (which there
// becomes wtx.mjs's bun), and printed another line of how the server ended:
// the case waits for the end (rs/parity/drive.mjs, {"until": "end"}).
add("ws: cols that is not a number ends the server", [{ ws: "?cwd=<CWD>&cols=abc" }, { recv: "a", until: "close", timeout: 3000 }, { until: "end" }], { shell: true, skip: NO_SH });
add("ws: ping with and without t", [
  create("k", QUIET),
  ...attach("?session=k"),
  { recv: "a", until: { quiet: 200 } },
  { send: "a", text: '{"type":"ping","t":42}' },
  { send: "a", text: '{"type":"ping","t":"x","more":1}' },
  { send: "a", text: '{"type":"ping","t":null}' },
  { send: "a", text: '{"type":"ping","t":[1.50,{"b":1,"a":2}]}' },
  { send: "a", text: '{"type":"ping"}' },
  { recv: "a", until: { quiet: 300 } },
]);
add("ws: text, JSON of other types and binary frames are typed into the session", [
  create("k", RAW),
  wait("k", "ready\r\n"),
  ...attach("?session=k"),
  { recv: "a", until: { quiet: 200 } },
  { send: "a", text: "abc" },
  { recv: "a", until: { text: "got 616263\r\n" } },
  { send: "a", text: '{"type":"other"}' },
  { recv: "a", until: { text: "7d\r\n" } },
  { send: "a", text: '{"type":"resize","cols":0,"rows":5}' },
  { recv: "a", until: { text: "7d\r\n" } },
  { send: "a", binary: "xyz" },
  { recv: "a", until: { text: "got 78797a\r\n" } },
  { send: "a", hex: "61ff62" },
  { recv: "a", until: { text: "62\r\n" } },
  { send: "a", text: "not json {" },
  { recv: "a", until: { text: "7b\r\n" } },
]);
add("ws: closing a client leaves the session running", [create("k", QUIET), ...attach("?session=k"), { close: "a" }, { until: "log", contains: "disconnected" }, LIST]);
add("ws: output reaches every client, after the replay", [
  create("k", ECHO),
  wait("k", "ready\r\n"),
  ...attach("?session=k"),
  ...attach("?session=k", "b"),
  { recv: "a", until: { quiet: 200 } },
  { recv: "b", until: { quiet: 200 } },
  { http: "POST /sessions/k/input?cr=1", body: "hi" },
  { recv: "a", until: { text: "0a\r\n" } },
  { recv: "b", until: { text: "0a\r\n" } },
]);

// ═══════════════════════════ size ═══════════════════════════

// bun prints its terminal's size at the start and whenever it changes (the
// `resize` event; at SIGWINCH, process.stdout.columns is still the old size).
const SIZE = "const s = () => process.stdout.write('size ' + process.stdout.columns + 'x' + process.stdout.rows + '\\n'); process.stdout.on('resize', s); s()";
const NO_RESIZE = { win32: "a program under ConPTY sees no resize (bun's resize event does not fire), so the case waits out its timeouts and its program's life, and what it shows depends on timing" };
add("size: the smallest of the clients, told to each", [
  create("k", SIZE, { cols: 120, rows: 40 }),
  wait("k", "size 120x40\r\n"),
  ...attach("?session=k&cols=100&rows=50"),
  { recv: "a", until: { type: "size" } },
  { recv: "a", until: { text: "size 100x50\r\n" } },
  ...attach("?session=k&cols=150&rows=30", "b"),
  { recv: "b", until: { type: "size" } },
  { recv: "a", until: { text: "size 100x30\r\n" } },
  { recv: "b", until: { text: "size 100x30\r\n" } },
  LIST,
], { skip: NO_RESIZE });
add("size: resize messages, clamped and floored; the last client's size stays", [
  create("k", SIZE),
  wait("k", "size 80x24\r\n"),
  ...attach("?session=k"),
  { recv: "a", until: { type: "size" } },
  { send: "a", text: '{"type":"resize","cols":"90","rows":20.9}' },
  { recv: "a", until: { text: "size 90x20\r\n" } },
  { send: "a", text: '{"type":"resize","cols":1,"rows":1}' },
  { recv: "a", until: { text: "size 10x2\r\n" } },
  { send: "a", text: '{"type":"resize","cols":"x","rows":5}' },
  { recv: "a", until: { quiet: 300 } },
  { close: "a" },
  { until: "log", contains: "disconnected" },
  LIST,
], { skip: NO_RESIZE });
add("size: a client leaving lets the others grow", [
  create("k", SIZE),
  wait("k", "size 80x24\r\n"),
  ...attach("?session=k&cols=100&rows=30"),
  { recv: "a", until: { text: "size 100x30\r\n" } },
  ...attach("?session=k&cols=60&rows=20", "b"),
  { recv: "a", until: { text: "size 60x20\r\n" } },
  { recv: "b", until: { text: "size 60x20\r\n" } },
  { close: "b" },
  { recv: "a", until: { text: "size 100x30\r\n" } },
  LIST,
], { skip: NO_RESIZE });

// ═══════════════════════════ OSC 7, queries, exit ═══════════════════════════

add("osc7: a shell reporting its directory moves the session", [
  ...attach(),
  { recv: "a", until: { text: "fake shell" } },
  { send: "a", text: "osc7 /some/where\r" },
  { recv: "a", until: { type: "cwd" } },
  { send: "a", text: "osc7 /some/where\r" },
  { recv: "a", until: { text: "where\u0007" } },
  { send: "a", text: "osc7st /p%C3%A4th%20x\r" },
  { recv: "a", until: { type: "cwd" } },
  { send: "a", text: "osc7 /bad%E0\r" },
  { recv: "a", until: { type: "cwd" } },
  LIST,
  { http: "GET /summary?cwd=/some" },
  { http: "GET /summary?cwd=/bad%25E0" },
], { shell: true, skip: NO_SH });
add("osc7: of two in one chunk, only the first counts", [
  create("k", say("\\x1b]7;file://h/one\\x07\\x1b]7;file://h/two\\x07.\\n")),
  wait("k", ".\r\n"),
  LIST,
]);
add("osc7: an OSC 7 without a path, or not ended, moves nothing", [
  create("k", say("\\x1b]7;file://host\\x07\\x1b]7;file://host/x\\n")),
  wait("k", "/x\r\n"),
  LIST,
]);
add("query: device attributes and cursor position are answered by the server", [
  create("k", "process.stdin.setRawMode(true); let got = ''; process.stdin.on('data', (d) => { got += Buffer.from(d).toString('hex') }); setTimeout(() => process.stdout.write('\\x1b[c'), 100); setTimeout(() => process.stdout.write('\\x1b[6n'), 400); setTimeout(() => process.stdout.write('\\x1b[0c\\x1b[6n'), 700); setTimeout(() => process.stdout.write('answers ' + got + '\\n'), 1200)"),
  wait("k", "\r\n"),
  { http: "GET /sessions/k/buffer" },
]);
add("exit: a session that ends says so, and stays listed", [
  create("k", "", { cmd: [BUN, "-e", "console.log('bye')"] }),
  { until: "log", contains: "PTY exited" },
  { http: "GET /sessions/k/buffer" },
  LIST,
  ...attach("?session=k"),
  { recv: "a", until: { quiet: 300 } },
  { http: "DELETE /sessions/k" },
  { recv: "a", until: { quiet: 300 } },
  LIST,
]);
add("exit: attaching by directory to a session that ended starts a new one", [
  ...attach(),
  { recv: "a", until: { text: "fake shell" } },
  { send: "a", text: "exit\r" },
  { recv: "a", until: { text: "[session ended]\u001b[0m\r\n" } },
  ...attach("?cwd=<CWD>", "b"),
  { recv: "b", until: { text: "fake shell" } },
  LIST,
], { shell: true, skip: NO_SH });
add("exit: deleting a session tells its clients", [create("k", QUIET), ...attach("?session=k"), { recv: "a", until: { quiet: 200 } }, { http: "DELETE /sessions/k" }, { recv: "a", until: { text: "[session ended]\u001b[0m\r\n" } }, LIST]);

// ═══════════════════════════ the session's environment ═══════════════════════════

// wtx means to pass a session only the variables of an allow-list (scrubSecrets),
// but bun-pty starts the program with the server's real environment, the one it
// was started with, and adds the allowed ones on top: so every variable of that
// reaches it. What bun read from .env is not in it (bun keeps that in process.env),
// so of a .env only the allowed names reach a session. /usr/bin/env through sh
// shows what the program got.
//
// It turns the terminal's ONLCR off first (stty -onlcr: a line ends in LF, not
// CR LF), here and in RAWENV below. With it on, macOS's line discipline writes
// one CR more ("\r\r\n") where its output queue fills up at a line's end: it
// has put the CR there, cannot put the LF, and puts both again once the reader
// has drained the queue. Whether that happens depends on how quickly bun-pty
// reads, and a few KB of variables are enough (the env: cases differed so, at
// LANG=, once on each side). These cases are about the environment; the CR LF
// of a terminal is shown by the buffer: and create: cases.
const ENV_DUMP = ["/bin/sh", "-c", "stty -onlcr; env | LC_ALL=C sort | grep -v -e '^_=' -e '^SHLVL=' -e '^PWD=' -e '^OLDPWD='; echo END; exec sleep 30"];
const NO_BIN_SH = { win32: "there is no /bin/sh for bun-pty to start on Windows" };
const envCase = (name, o) => add(`env: ${name}`, [{ http: "POST /sessions/k", body: { cmd: ENV_DUMP } }, wait("k", "END\n"), { http: "GET /sessions/k/buffer" }], { skip: NO_BIN_SH, ...o });
envCase("every variable of the server reaches a session, wtx's own on top", {
  env: {
    OPENAI_API_KEY: "dummy-secret",
    AWS_SECRET_ACCESS_KEY: "dummy",
    TERMINAL_ACCESS_KEY: "dummy-key",
    MY_TOKEN: "x",
    EDITOR: "vi",
    LC_PARITY: "ok",
    XDG_PARITY: "ok",
    GIT_PARITY: "ok",
    SSH_PARITY: "ok",
    TERMINFO_DIRS: "ok",
    GH_TOKEN: "passes",
    TERM: "dumb",
    COLORTERM: "no",
    HOST: "elsewhere",
    LANG: "fr_FR.UTF-8",
    PROMPT_COMMAND: "echo mine",
    ZDOTDIR: "<ROOT>/zdot",
    lc_lower: "dropped",
  },
});
envCase("what bun loads from .env does not reach a session, but for names on the allow-list", { files: { ".env": "PARITY_SECRET=from-env-file\nLC_FROM_FILE=passes\n" } });
envCase("PROMPT_COMMAND without one of the server's", { env: { PROMPT_COMMAND: null } });

// ═══════════════════════════ an independent verifier's cases (v-) ═══════════════════════════

// Written by the port's verifier, aimed at what the cases above may have
// missed; here as they ran, except where said. Start-ups that end at
// Bun.serve (TERMINAL_WS_PORT=99999) run with the runner's own streams
// (PARITY_DIRECT, see rs/parity/drive.mjs): a terminal, stdin.
const NO_WIN = { win32: "POSIX paths, a #! script and /bin/sh" };
const DEAD = { TERMINAL_WS_PORT: "99999" };
const direct = (name, o = {}) => add(name, [], { ...o, env: { ...DEAD, PARITY_DIRECT: "1", ...(o.env || {}) } });

// ── the runtime the binary hands wtx.mjs to: as the system starts wtx.mjs ──
// The TypeScript's side is wtx.mjs itself, as npm installs it (PARITY_AS_SCRIPT),
// so that `env` looks for bun on the server's PATH (PARITY_PATH; the setup
// lines keep the runner's, and {PATH} in it stands for that).
const asScript = (name, o) => direct(`v-path: ${name}`, { ...o, env: { PARITY_AS_SCRIPT: "1", ...o.env, ...(o.noStandIn ? { PARITY_STAND_IN_CANNOT_RUN: o.noStandIn } : {}) }, skip: NO_WIN });
const NO_BUN = "there is no bun on the server's PATH";
const nodeOnly = ['mkdir -p "<ROOT>/nodeonly" && ln -s "$(command -v node)" "<ROOT>/nodeonly/node"'];
asScript("only node on PATH, no bun", { env: { PARITY_PATH: "<ROOT>/nodeonly" }, setup: nodeOnly, noStandIn: NO_BUN });
asScript("only node on PATH, with --help", { args: ["--help"], env: { PARITY_PATH: "<ROOT>/nodeonly" }, setup: nodeOnly, noStandIn: NO_BUN });
asScript("neither bun nor node on PATH", { env: { PARITY_PATH: "<ROOT>/empty" }, noStandIn: NO_BUN });
asScript("PATH unset", { env: { PARITY_PATH_UNSET: "1" }, noStandIn: "there may be no bun where a PATH that is not set leads" });
/** A bun on PATH that logs how it was started and starts the real one. */
const shim = (dir) => `mkdir -p "${dir}" && printf '#!/bin/sh\\necho "$0 $*" >> "%s"\\nexec "%s" "$@"\\n' "<ROOT>/bun.log" "$(command -v bun)" > "${dir}/bun" && chmod +x "${dir}/bun"`;
const BUN_LOG = ['cat "<ROOT>/bun.log"'];
asScript("a bun wrapper first on PATH sees the same command line", { args: ["--help", "x y", "é"], env: { PARITY_PATH: "<ROOT>/shim:{PATH}" }, setup: [shim("<ROOT>/shim")], after: BUN_LOG });
asScript("a bun that is not executable comes first on PATH", { env: { PARITY_PATH: "<ROOT>/noexec:{PATH}" }, setup: ['mkdir -p "<ROOT>/noexec" && echo "echo wrong bun" > "<ROOT>/noexec/bun" && chmod 644 "<ROOT>/noexec/bun"'] });
asScript("a directory named bun comes first on PATH", { env: { PARITY_PATH: "<ROOT>/dirbun:{PATH}" }, setup: ['mkdir -p "<ROOT>/dirbun/bun"'] });
asScript("a bun wrapper in a relative PATH entry", { env: { PARITY_PATH: "rel:{PATH}" }, setup: [shim("rel")], after: BUN_LOG });
asScript("an empty PATH entry finds a bun wrapper in the working directory", { env: { PARITY_PATH: ":{PATH}" }, setup: [shim(".")], after: BUN_LOG });
asScript("a bun on PATH that is a script without #!", { noStandIn: "the bun first on the server's PATH is not bun", env: { PARITY_PATH: "<ROOT>/nosb:{PATH}" }, setup: ['mkdir -p "<ROOT>/nosb" && printf \'echo "no shebang bun $*"\\nexit 7\\n\' > "<ROOT>/nosb/bun" && chmod +x "<ROOT>/nosb/bun"'] });

// ── command lines and what bun reads before the program ──
const start = (name, args, o = {}) => direct(`v-start: ${name}`, { ...o, args });
start("help as the only word", ["help"]);
start("-h", ["-h"]);
start("--version --help", ["--version", "--help"]);
start("an empty argument", [""]);
start("non-ASCII arguments", ["héllo", "日本語", "😀"]);
start("-- and -", ["--", "-"]);
start("arguments with a newline and a tab", ["a\nb", "tab\there"]);
start("flags that look like a port", ["--port=1", "-p", "2", "--host", "0.0.0.0"]);
start("a thousand arguments", Array.from({ length: 1000 }, (_, i) => `a${i}`));
start("one argument of 100 KB", ["x".repeat(100 * 1024)], { skip: { win32: "Windows takes a command line of at most 32,767 characters" } });
start("WTX_NO_NATIVE empty", [], { env: { WTX_NO_NATIVE: "" } });
start("WTX_NO_NATIVE=0", [], { env: { WTX_NO_NATIVE: "0" } });
start("input on stdin", [], { stdin: "some input\n" });
start("FORCE_COLOR=1 through pipes", [], { env: { FORCE_COLOR: "1" } });
start("NO_COLOR and FORCE_COLOR", [], { env: { NO_COLOR: "1", FORCE_COLOR: "1" } });
start("NODE_ENV=production", [], { env: { NODE_ENV: "production" } });
const NO_TTY = { win32: "the runner gives a terminal on Linux and macOS only" };
start("on a terminal (bun's colours)", [], { tty: true, skip: NO_TTY });
start("stdout alone a terminal", [], { tty: "stdout", skip: NO_TTY });
start("on a terminal with NO_COLOR", [], { tty: true, env: { NO_COLOR: "1" }, skip: NO_TTY });
start("on a terminal with TERM=dumb", [], { tty: true, env: { TERM: "dumb" }, skip: NO_TTY });
start("TERMINAL_WS_PORT 65536", [], { env: { TERMINAL_WS_PORT: "65536" } });
start("TERMINAL_WS_PORT in full-width digits", [], { env: { TERMINAL_WS_PORT: "１２３" } });
start("TERMINAL_WS_PORT 99999e9 (parseInt stops at e)", [], { env: { TERMINAL_WS_PORT: "99999e9" } });
// A preload prints only in the server (wtx.mjs): where `node` is bun, the
// parity runner runs on bun, which takes BUN_OPTIONS too.
const IN_WTX = 'if (/wtx\\.mjs$/.test(process.argv[1] ?? "")) ';
start("BUN_OPTIONS with a preload", [], { env: { BUN_OPTIONS: "--preload <ROOT>/pre.mjs" }, setup: [`printf '%s\\n' '${IN_WTX}console.error("preloaded " + process.argv.length)' > "<ROOT>/pre.mjs"`] });
start("bunfig.toml in the working directory preloads a script", [], { files: { "bunfig.toml": 'preload = ["./pre.mjs"]\n', "pre.mjs": 'console.error("bunfig preload");\n' } });
start("bunfig.toml that is not TOML", [], { files: { "bunfig.toml": "this is [not toml\n" }, env: { PARITY_STAND_IN_CANNOT_RUN: "bun refuses the bunfig.toml of the working directory" } });
start("package.json in the working directory that is not JSON", [], { files: { "package.json": "{ not json" } });
start("tsconfig.json in the working directory that is not JSON", [], { files: { "tsconfig.json": '{ "compilerOptions": ' } });
start("package.json above the working directory that is not JSON", [], { setup: ['echo "{ nope" > "<ROOT>/package.json"'] });
start("TERMINAL_WS_PORT from .env", [], { env: { TERMINAL_WS_PORT: null }, files: { ".env": "TERMINAL_WS_PORT=99999\n" } });
start(".env with CRLF line ends", [], { env: { TERMINAL_WS_PORT: null }, files: { ".env": "TERMINAL_WS_PORT=99999\r\nOTHER=1\r\n" } });
start(".env.production under NODE_ENV=production", [], { env: { TERMINAL_WS_PORT: null, NODE_ENV: "production" }, files: { ".env.production": "TERMINAL_WS_PORT=99998\n", ".env.development": "TERMINAL_WS_PORT=99997\n" } });
start(".env with $VAR expansion and quotes", [], { env: { TERMINAL_WS_PORT: null, BASE: "999" }, files: { ".env": 'TERMINAL_WS_PORT="${BASE}99"\n' } });
start("TERMINAL_WS_HOST from .env, an address this machine lacks", [], { env: { TERMINAL_WS_PORT: null }, files: { ".env": "TERMINAL_WS_HOST=192.0.2.1\n" } });
const TMPLS = ['ls -A "$TMPDIR" 2>&1; ls -A "$TMPDIR/koho-term-zshrc" 2>&1'];
start("TMPDIR with a space and non-ASCII", [], { env: { TMPDIR: "<ROOT>/t mp é" }, setup: ['mkdir -p "<ROOT>/t mp é"'], after: ['ls -A "<ROOT>/t mp é/koho-term-zshrc"'], skip: NO_WIN });
start("TMPDIR that does not exist is made", [], { env: { TMPDIR: "<ROOT>/not/yet" }, after: ['ls -A "<ROOT>/not/yet/koho-term-zshrc"'], skip: NO_WIN });
start("TMPDIR a symbolic link", [], { env: { TMPDIR: "<ROOT>/tlink" }, setup: ['mkdir -p "<ROOT>/treal" && ln -s "<ROOT>/treal" "<ROOT>/tlink"'], after: ['ls -A "<ROOT>/treal/koho-term-zshrc"'], skip: NO_WIN });
start("TMPDIR with a trailing slash", [], { after: TMPLS, env: { TMPDIR: "<ROOT>/tslash/" }, setup: ['mkdir -p "<ROOT>/tslash"'], skip: NO_WIN });
start("HOME unset", [], { env: { HOME: null } });
start("LANG and LC_ALL of another language", [], { env: { LANG: "tr_TR.UTF-8", LC_ALL: "de_DE.ISO-8859-1" } });

// ── the server, driven ──
/** The environment a session's program gets, in its own order. It waits a
 *  moment first (bun-pty sometimes loses what a program writes at once), and
 *  turns ONLCR off (see ENV_DUMP). */
const RAWENV = ["/bin/sh", "-c", "sleep 0.3; stty -onlcr; /usr/bin/env; echo END; exec sleep 30"];
const RAWENV_STEPS = [{ http: "POST /sessions/k", body: { cmd: RAWENV } }, wait("k", "END\n"), { http: "GET /sessions/k/buffer" }];
const vEnv = (name, env, o = {}) => add(`v-env: ${name}`, RAWENV_STEPS, { env, skip: NO_WIN, ...o });
vEnv("the order of the variables a session gets", { ZZ_LAST: "1", AA_FIRST: "2", MM_MIDDLE: "3", BB: "4" });
vEnv("names that sort differently by byte and by case", { "é_VAR": "1", a_lower: "2", _UNDER: "3", Z9: "4", "A-B": "5", "1X": "6" });
vEnv("an empty value and a value with a newline", { EMPTY: "", NL: "line1\nline2", EQ: "a=b=c" });
vEnv("what bun loads from .env, in order", {}, { files: { ".env": "Z_FROM_FILE=1\nA_FROM_FILE=2\n" } });
// (The verifier's "WTX_PACKAGE_ROOT in the user's own environment" set it to
// the package's own directory, which is also how the runner points the binary
// at the package here: the binary takes such a value for the launcher's. Its
// installed form is below, v-install, with a directory of the user's own.)
add("v-http: HEAD and OPTIONS on the routes", [create("k", say("x")), wait("k", "x"), { http: "HEAD /sessions" }, { http: "OPTIONS /sessions" }, { http: "HEAD /sessions/k/buffer" }, { http: "OPTIONS /sessions/k" }, { http: "HEAD /summary?cwd=<CWD>" }]);
add("v-http: an absolute-form request target", [{ http: "GET http://127.0.0.1:{PORT}/sessions" }, { http: "GET http://elsewhere.test/sessions" }]);
add("v-http: repeated query parameters", [
  create("k", say("one\\ntwo\\nthree\\n")),
  wait("k", "three"),
  { http: "GET /sessions/k/buffer?tail=1&tail=2" },
  { http: "GET /sessions/k/buffer?strip=0&strip=1" },
  { http: "GET /summary?cwd=/nowhere&cwd=<CWD>" },
]);
add("v-http: a 100 KB body typed into a session", [
  create("k", "process.stdin.setRawMode(true); let n = 0; process.stdin.on('data', (d) => { n += d.length; if (n >= 102400) process.stdout.write('got all ' + n + '\\n') }); process.stdout.write('ready\\n')"),
  wait("k", "ready"),
  { http: "POST /sessions/k/input", body: "y".repeat(100 * 1024) },
  wait("k", "got all"),
  LIST,
], { timeout: 60 });
add("v-http: session keys with an emoji, %2F and a plus", [create("%F0%9F%98%80", QUIET), create("a%2Fb", QUIET), create("c+d", QUIET), LIST, { http: "GET /sessions/c+d/buffer" }, { http: "DELETE /sessions/a%2Fb" }, LIST]);
add("v-http: a JSON body with a BOM, CRLF and a duplicate key", [
  { http: "POST /sessions/a", bodyHex: Buffer.from('﻿{"cmd":["' + BUN + '","-e","setTimeout(()=>{},30000)"]}').toString("hex") },
  { http: "POST /sessions/b", body: '{\r\n"cols": 50,\r\n"cols": 60,\r\n"cmd":["' + BUN + '","-e","setTimeout(()=>{},30000)"]\r\n}' },
  LIST,
], { shell: true, skip: NO_WIN });
add("v-http: a command line with non-ASCII and a newline", [
  { http: "POST /sessions/k", body: { cmd: [BUN, "-e", "process.stdout.write(process.argv.slice(1).join('|') + '.'); setTimeout(() => {}, 30000)", "é 😀", "a\nb"] } },
  wait("k", "."),
  { http: "GET /sessions/k/buffer" },
]);
add("v-ws: a directory with a space and non-ASCII, percent-encoded", [...attach("?cwd=<CWD>/d%20%C3%A9"), { recv: "a", until: { text: "fake shell" } }, LIST], { shell: true, after: ["ls"], skip: NO_WIN });
add("v-ws: a trailing slash makes another session", [
  ...attach(),
  { recv: "a", until: { text: "fake shell" } },
  ...attach("?cwd=<CWD>/", "b"),
  { recv: "b", until: { text: "fake shell" } },
  LIST,
], { shell: true, env: { PARITY_DIRS: JSON.stringify(["<CWD>/"]) }, skip: NO_WIN });
// (The program waits a moment before it prints, unlike the verifier's: what a
// program writes at once sometimes never reaches wtx, which bun-pty loses.)
add("v-buffer: output that is not UTF-8", [
  { http: "POST /sessions/k", body: { cmd: ["/bin/sh", "-c", "sleep 0.3; printf 'a\\377b\\303(c\\342\\202d.\\n'; exec sleep 30"] } },
  wait("k", "."),
  { http: "GET /sessions/k/buffer" },
  { http: "GET /sessions/k/buffer?strip=1" },
], { skip: NO_WIN });
add("v-buffer: wide characters on the screen", [create("k", say("日本語のテキスト😀😀😀abc\\n\\u00e9\\u0301x\\n"), { cols: 12, rows: 6 }), wait("k", "x\r\n"), { http: "GET /sessions/k/buffer?strip=1" }, { http: "GET /sessions/k/buffer?tail=2" }]);
add("v-summary: a trailing slash and an encoded directory", [create("k", say("⏺ Done?§\\n"), { cwd: "<CWD>/x y" }), wait("k", "§"), { http: "GET /summary?cwd=<CWD>/x%20y/" }, { http: "GET /summary?cwd=<CWD>/x+y" }, { http: "GET /summary?cwd=<CWD>/x%20y" }]);
add("v-status: WTX_REPO_BASE with a trailing slash", [create("k", QUIET, { cwd: "<ROOT>/repos/me/proj" }), { http: "GET /status/me/proj" }, { http: "GET /status/me/proj/" }], { env: { WTX_REPO_BASE: "<ROOT>/repos/" } });
add("v-start: TERMINAL_WS_PORT 0 listens somewhere", [], { env: { TERMINAL_WS_PORT: "0" } });
add("v-start: TERMINAL_WS_PORT with a leading zero", [LIST], { env: { TERMINAL_WS_PORT: "0{PORT}" } });
add("v-start: TERMINAL_WS_HOST localhost", [LIST], { env: { TERMINAL_WS_HOST: "localhost" } });
add("v-start: TERMINAL_WS_HOST 127.1", [LIST], { env: { TERMINAL_WS_HOST: "127.1" } });
add("v-start: TERMINAL_WS_HOST ::1", [], { env: { TERMINAL_WS_HOST: "::1" } });
add("v-access: an empty TERMINAL_ACCESS_KEY from another address", [{ http: "GET /sessions", ...OTHER }, { http: "GET /sessions?key=", ...OTHER }], { env: { TERMINAL_ACCESS_KEY: "" }, skip: NO_SECOND_LOOPBACK });

// ── installed as npm installs it: the first run goes through the launcher ──
// PARITY_INSTALL (rs/parity/drive.mjs): the TypeScript's side is @snomiao/wtx
// 0.3.4 as published (bin/wtx is wtx.mjs), the binary's the package that
// rs/parity/proof.sh packs (bin/wtx is rustify's launcher, under bun); "second
// run" is after the launcher has put the binary in its place. bun has loaded
// the working directory's .env files and run its preloads before the
// launcher's first line; launcher v3 gives the binary the environment the
// command was started with, not that process.env. A preload that ran in the
// launcher printed in the launcher too: on a first run these cases' preloads
// print only in wtx.mjs (IN_WTX), and rs/parity/launcher.mjs shows that extra
// run. The npm layout here is a POSIX one: not on Windows, where
// rs/parity/launcher.mjs installs with bun and npm for real.
const NO_WIN_INSTALL = { win32: "npm installs a command shim (.cmd) on Windows, which this layout of symbolic links is not" };
const installed = (name, steps, o = {}) =>
  add(`v-install: ${name}`, steps, { ...o, env: { PARITY_INSTALL: "1", ...(o.second ? { PARITY_INSTALL_RUNS: "2" } : {}), ...(o.env || {}) }, skip: NO_WIN_INSTALL });
const installedStart = (name, o = {}) => installed(name, [], { ...o, env: { ...DEAD, PARITY_DIRECT: "1", ...(o.env || {}) } });
installedStart("first run, plain");
installedStart("second run, plain", { second: true });
installedStart("first run, --version and other words", { args: ["--version", "x"] });
const BUNFIG_PRELOAD = { "bunfig.toml": 'preload = ["./pre.mjs"]\n', "pre.mjs": 'console.error("bunfig preload ran");\n' };
installedStart("second run, a bunfig.toml preload in the working directory", { second: true, files: BUNFIG_PRELOAD });
installedStart("second run, BUN_OPTIONS with a preload", { second: true, env: { BUN_OPTIONS: "--preload <ROOT>/pre.mjs" }, setup: [`printf '%s\\n' '${IN_WTX}console.error("BUN_OPTIONS preload ran")' > "<ROOT>/pre.mjs"`] });
installedStart("second run, NODE_ENV=production set in .env", { second: true, env: { TERMINAL_WS_PORT: null }, files: { ".env": "NODE_ENV=production\nTERMINAL_WS_HOST=192.0.2.1\n", ".env.production": "TERMINAL_WS_PORT=99998\n" } });
// On a first run, bun has applied all of these in the launcher already.
const SECRETS = { ".env": "OPENAI_API_KEY=sk-dummy-from-dotenv\nTERMINAL_ACCESS_KEY=dummy-key-from-dotenv\n" };
const PRODUCTION = { ".env": "NODE_ENV=production\nTERMINAL_WS_HOST=192.0.2.1\n", ".env.production": "TERMINAL_WS_PORT=99998\n" };
const BUNFIG_PRELOAD_IN_WTX = { "bunfig.toml": 'preload = ["./pre.mjs"]\n', "pre.mjs": `${IN_WTX}console.error("bunfig preload ran");\n` };
installedStart("first run, NODE_ENV=production set in .env", { env: { TERMINAL_WS_PORT: null }, files: PRODUCTION });
installedStart("first run, .env.local and .env.development set the port", { env: { TERMINAL_WS_PORT: null }, files: { ".env.local": "TERMINAL_WS_PORT=99997\n", ".env.development": "TERMINAL_WS_PORT=99996\nTERMINAL_WS_HOST=192.0.2.1\n" } });
installedStart("first run, a bunfig.toml preload in the working directory", { files: BUNFIG_PRELOAD_IN_WTX });
installedStart("first run, BUN_OPTIONS with a preload", { env: { BUN_OPTIONS: "--preload <ROOT>/pre.mjs" }, setup: [`printf '%s\\n' '${IN_WTX}console.error("BUN_OPTIONS preload ran")' > "<ROOT>/pre.mjs"`] });
installedStart("first run, a .env and BUN_OPTIONS without a preload", { files: SECRETS, env: { BUN_OPTIONS: "--smol" } });
installedStart("first run, the launcher cannot link (RUSTIFY_NO_LINK=1), and a .env", { files: PRODUCTION, env: { TERMINAL_WS_PORT: null, RUSTIFY_NO_LINK: "1" } });
installedStart("first run, WTX_NO_NATIVE=1 and a .env", { files: PRODUCTION, env: { TERMINAL_WS_PORT: null, WTX_NO_NATIVE: "1" } });
installedStart("first run, NODE_OPTIONS with a preload (bun does not read it)", { env: { NODE_OPTIONS: "--require <ROOT>/pre.cjs" }, setup: ['echo \'console.error("NODE_OPTIONS preload ran")\' > "<ROOT>/pre.cjs"'] });
installedStart("first run, an .env.example and an .envrc (bun reads neither)", { files: { ".env.example": "TERMINAL_WS_PORT=1\n", ".envrc": "export TERMINAL_WS_PORT=2\n" } });
installedStart("first run, a package.json here that is not JSON", { files: { "package.json": "{ not json" } });
installed("first run, the variables of a session", RAWENV_STEPS, { env: { ZZ: "1", AA: "2" } });
installed("first run, a secret in .env and a session", RAWENV_STEPS, { files: SECRETS });
installed("first run, RUSTIFY_NO_LINK=1, a secret in .env and a session", RAWENV_STEPS, { files: SECRETS, env: { RUSTIFY_NO_LINK: "1" } });
installed("second run, a secret in .env and a session", RAWENV_STEPS, { second: true, files: SECRETS });
installed("second run, the user's own WTX_PACKAGE_ROOT reaches a session", RAWENV_STEPS, { second: true, env: { PARITY_WTX_PACKAGE_ROOT: "<ROOT>/mine" } });

// ═══════════════════════════ systems ═══════════════════════════

// Steps that open a WebSocket from 127.0.0.2 need that loopback address.
for (const c of cases) {
  if (!/"from":"127\.0\.0\.2"/.test(c.env.PARITY_STEPS)) continue;
  if (!c.skip?.darwin) throw new Error(`${c.name}: a client from 127.0.0.2 needs a skip on darwin`);
}

// ═══════════════════════════ write ═══════════════════════════

const out = { env: { TZ: "UTC" }, cases };
const text = JSON.stringify(out, null, 1) + "\n";
if (flags.has("--list")) {
  for (const c of cases) console.log(`${c.name}${c.skip ? `  [skipped on ${Object.keys(c.skip).join(", ")}]` : ""}`);
} else if (flags.has("--check")) {
  if (!fs.existsSync(OUT) || fs.readFileSync(OUT, "utf8") !== text) {
    console.error("rs/parity.json is not what rs/parity.gen.mjs writes; run `node rs/parity.gen.mjs`");
    process.exit(1);
  }
  console.error(`rs/parity.json is up to date (${cases.length} cases)`);
} else {
  fs.writeFileSync(OUT, text);
  const skipped = (system) => cases.filter((c) => c.skip?.[system]).length;
  console.error(`wrote rs/parity.json (${cases.length} cases, every one handed back; skipped on darwin ${skipped("darwin")}, win32 ${skipped("win32")})`);
}
