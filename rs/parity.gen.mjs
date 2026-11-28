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
// Every case has its own empty HOME and temp directory (the runner's), and
// TMPDIR there holds the koho-term-zshrc directory wtx writes at start-up.
// No case reaches the network: the server listens on 127.0.0.1 (or fails to
// listen), and git only ever works on repositories inside the case.

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
add("start: TERMINAL_WS_HOST empty", [LIST], { env: { TERMINAL_WS_HOST: "" } });
add("start: TERMINAL_WS_HOST 0.0.0.0", [LIST], { env: { TERMINAL_WS_HOST: "0.0.0.0" } });
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
add("ws: cols that is not a number ends the server", [{ ws: "?cwd=<CWD>&cols=abc" }, { recv: "a", until: "close", timeout: 3000 }], { shell: true, skip: NO_SH });
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
]);
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
]);
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
]);

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
// but bun-pty starts the program with the server's whole environment and adds the
// allowed ones on top, so every variable reaches it. /usr/bin/env through sh shows
// what the program got (bun would load the .env of its directory itself).
const ENV_DUMP = ["/bin/sh", "-c", "env | LC_ALL=C sort | grep -v -e '^_=' -e '^SHLVL=' -e '^PWD=' -e '^OLDPWD='; echo END"];
const NO_BIN_SH = { win32: "there is no /bin/sh for bun-pty to start on Windows" };
const envCase = (name, o) => add(`env: ${name}`, [{ http: "POST /sessions/k", body: { cmd: ENV_DUMP } }, wait("k", "END\r\n"), { http: "GET /sessions/k/buffer" }], { skip: NO_BIN_SH, ...o });
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
envCase("what bun loads from .env reaches a session too", { files: { ".env": "PARITY_SECRET=from-env-file\nLC_FROM_FILE=passes\n" } });
envCase("PROMPT_COMMAND without one of the server's", { env: { PROMPT_COMMAND: null } });

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
