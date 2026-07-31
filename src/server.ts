/**
 * Terminal WebSocket server — raw PTY sessions, no tmux.
 *
 * Sessions persist across WebSocket disconnects via an in-memory map.
 * Each session holds a bun-pty process + 1MB replay buffer.
 * Multiple WS clients can attach to the same session (multi-tab).
 *
 * Why no tmux? tmux mouse mode intercepts all mouse events, preventing
 * xterm.js native text selection. Without mouse mode, scroll breaks.
 * There's no clean way to have both. VS Code's terminal works the same way.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";

/**
 * Base directory under which `/status/:owner/:repo` resolves to
 * `<REPO_BASE>/<owner>/<repo>`. Override with WTX_REPO_BASE env var.
 * If unset, the route is disabled (returns 404).
 */
const REPO_BASE = process.env.WTX_REPO_BASE ?? "";

/**
 * Render raw PTY bytes through a headless xterm.js instance so that cursor
 * movement, in-place updates (Claude Code's spinner, progress bars, etc.)
 * are resolved into the final screen state before we read back the text.
 * Falls back to regex-strip if @xterm/headless is unavailable.
 */
async function renderTerminalBuffer(
  data: Uint8Array,
  cols: number,
  rows: number,
  tailN = 0,
  offsetN = 0,
): Promise<string> {
  try {
    const { Terminal } = await import("@xterm/headless");
    // scrollback must hold at least tailN+offsetN lines so slice works correctly.
    // cat (tailN==0 && offsetN==0): large scrollback for full history.
    const scrollback = tailN > 0 || offsetN > 0 ? tailN + offsetN + rows : 50000;
    const term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    await new Promise<void>((resolve) => term.write(data, resolve));
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(false).trimEnd() : "");
    }
    // Remove trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    if (tailN > 0 || offsetN > 0) {
      const end = offsetN > 0 ? Math.max(0, lines.length - offsetN) : lines.length;
      const start = tailN > 0 ? Math.max(0, end - tailN) : 0;
      return lines.slice(start, end).join("\n");
    }
    return lines.join("\n");
  } catch {
    // Fallback: regex strip
    let text = new TextDecoder().decode(data);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal data
    const ansi = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal data
    const ctrl = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
    text = text.replace(ansi, "").replace(ctrl, "");
    const splitLines = text.split("\n");
    const end = offsetN > 0 ? Math.max(0, splitLines.length - offsetN) : splitLines.length;
    const start = tailN > 0 ? Math.max(0, end - tailN) : 0;
    return splitLines.slice(start, end).join("\n");
  }
}

// --- OSC 7 CWD reporting setup ---

// Create a temp ZDOTDIR so zsh emits OSC 7 on every prompt
const KOHO_ZDOTDIR = join(tmpdir(), "koho-term-zshrc");
mkdirSync(KOHO_ZDOTDIR, { recursive: true });
writeFileSync(
  join(KOHO_ZDOTDIR, ".zshenv"),
  `[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"\n`,
);
writeFileSync(
  join(KOHO_ZDOTDIR, ".zprofile"),
  `[[ -f "$HOME/.zprofile" ]] && source "$HOME/.zprofile"\n`,
);
writeFileSync(
  join(KOHO_ZDOTDIR, ".zshrc"),
  `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
_koho_report_cwd() { printf '\\033]7;file://%s%s\\007' "\${HOST:-localhost}" "$PWD"; }
precmd_functions+=(_koho_report_cwd)
`,
);

// OSC 7: \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/.+?)(?:\x07|\x1b\\)/;
const OSC7_MARKER = 0x1b; // ESC — quick pre-check before running regex
const textDecoder = new TextDecoder();

function extractOsc7Cwd(data: Uint8Array): string | null {
  if (!data.includes(OSC7_MARKER)) return null;
  const text = textDecoder.decode(data);
  if (!text.includes("\x1b]7;")) return null;
  const m = text.match(OSC7_RE);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

const PORT = parseInt(process.env.TERMINAL_WS_PORT ?? "3004");
// Access key for external (non-loopback) connections. Set TERMINAL_ACCESS_KEY in .env.
// Local 127.0.0.1 connections are always allowed without a key.
const ACCESS_KEY = process.env.TERMINAL_ACCESS_KEY ?? "";
const MIN_COLS = 10;
const MIN_ROWS = 2;
const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB replay buffer

// --- PTY abstraction ---

interface PtyHandle {
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: Uint8Array) => void): void;
  onExit(cb: () => void): void;
}

/**
 * Allow-list of environment variables that may be inherited by user-facing
 * PTY sessions. Anything not on this list (by exact name OR by prefix) is
 * dropped before spawning a shell, so secrets loaded into the terminal-ws
 * process from .env / .env.local cannot leak.
 *
 * If you add a variable to .env that genuinely needs to reach user shells,
 * add its name (or a safe prefix) here AND mirror the change in
 * pm2/vscode.sh's `env -i` invocation.
 */
const ALLOW_ENV_NAMES = new Set<string>([
  // POSIX core
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOSTNAME",
  "HOSTTYPE",
  "MACHTYPE",
  "OSTYPE",
  // GUI / display
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  // SSH agent forwarding (needed for `git push` over ssh)
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  // Editor / pager preferences
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPAGER",
  "LESS",
  "MORE",
  // Tooling that shells/dev tools expect
  "KUBECONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "GITHUB_OWNER",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  // Shell init contract
  "ZDOTDIR",
  // VS Code integrated terminal contract
  "VSCODE_IPC_HOOK_CLI",
  "VSCODE_GIT_ASKPASS_NODE",
  "VSCODE_GIT_ASKPASS_MAIN",
  "VSCODE_GIT_IPC_HANDLE",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  // Windows essentials (codehost runs on Win in some envs)
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "SystemDrive",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "ComSpec",
  "OS",
  "PATHEXT",
  "WINDIR",
  "COMPUTERNAME",
  "USERNAME",
  "USERDOMAIN",
  "USERDOMAIN_ROAMINGPROFILE",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  // Codehost own ports/config that the shell might want to display in prompts
  "CODEHOST",
  "CODEHOST_ROOT",
]);

// Prefixes whose entire namespace is considered safe (used by package
// managers, runtimes, shells, etc — they hold preferences, not credentials).
const ALLOW_ENV_PREFIXES = [
  "LC_",
  "XDG_",
  "NODE_",
  "npm_",
  "NPM_",
  "BUN_",
  "PNPM_",
  "YARN_",
  "GIT_", // git config; user PATs use GH_TOKEN/GITHUB_TOKEN, not GIT_*
  "VSCODE_",
  "TERMINFO",
  "SSH_", // SSH_CLIENT, SSH_CONNECTION, SSH_TTY (already covers SSH_AUTH_SOCK)
];

function scrubSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (ALLOW_ENV_NAMES.has(k) || ALLOW_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

function spawnPty(
  cmd: string[],
  args: string[],
  cols: number,
  rows: number,
  cwd: string,
): PtyHandle {
  const { spawn: ptySpawn } = require("bun-pty");
  console.log(`[term] spawning: bun-pty → ${cmd[0]} ${args.join(" ")} (${cols}x${rows}) in ${cwd}`);

  const pty = ptySpawn(cmd[0], [...cmd.slice(1), ...args], {
    cols,
    rows,
    cwd,
    env: {
      ...scrubSecrets(process.env),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      // Override any inherited HOST/HOSTNAME (e.g. portless sets HOST=127.0.0.1
      // for the proxied dev processes) so zsh's %m prompt shows the real host.
      HOST: hostname(),
      HOSTNAME: hostname(),
      // OSC 7 CWD reporting
      ZDOTDIR: KOHO_ZDOTDIR,
      // bash fallback
      PROMPT_COMMAND: `printf '\\033]7;file://%s%s\\007' "$HOSTNAME" "$PWD"${process.env.PROMPT_COMMAND ? `; ${process.env.PROMPT_COMMAND}` : ""}`,
    },
  });

  return {
    write(data) {
      pty.write(typeof data === "string" ? data : new TextDecoder().decode(data));
    },
    resize(cols, rows) {
      pty.resize(cols, rows);
    },
    kill() {
      pty.kill();
    },
    onData(cb) {
      pty.onData((str: string) => cb(new TextEncoder().encode(str)));
    },
    onExit(cb) {
      pty.onExit(cb);
    },
  };
}

// --- Session map ---

interface Session {
  pty: PtyHandle;
  buffer: Uint8Array[];
  bufferBytes: number;
  clients: Set<ServerWebSocket<WSData>>;
  cols: number;
  rows: number;
  /** The command used to spawn this session (for logging) */
  cmd: string[];
  cwd: string;
  startedAt: number; // Date.now() when session was created
  lastActivity: number; // Date.now() on last pty output
  onExit?: () => void;
}

const sessions = new Map<string, Session>();

/** Exported so agents.tsx can register a session for an agent process. */
export function createSession(
  sessionKey: string,
  cmd: string[],
  cols: number,
  rows: number,
  cwd: string,
  onExit?: () => void,
): Session {
  // Kill existing session with same key if any
  const existing = sessions.get(sessionKey);
  if (existing) {
    console.log(`[term] replacing existing session ${sessionKey}`);
    existing.pty.kill();
    sessions.delete(sessionKey);
  }

  const pty = spawnPty(cmd, [], cols, rows, cwd);
  const session: Session = {
    pty,
    buffer: [],
    bufferBytes: 0,
    clients: new Set(),
    cols,
    rows,
    cmd,
    cwd,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    onExit,
  };

  // Broadcast PTY output to all clients + buffer for replay
  pty.onData((data) => {
    session.lastActivity = Date.now();

    // Intercept terminal queries and respond server-side so the PTY process
    // never blocks waiting for xterm.js (which stalls in background tabs).
    const text = textDecoder.decode(data);
    // Device Attributes (DA) query: ESC[c or ESC[0c → respond VT100+AVO
    if (text.includes("\x1b[c") || text.includes("\x1b[0c")) {
      pty.write("\x1b[?1;2c");
    }
    // Cursor Position Report (DSR/CPR): ESC[6n → respond row 1, col 1
    // (exact position unknown server-side, but unblocks the process)
    if (text.includes("\x1b[6n")) {
      pty.write(`\x1b[1;1R`);
    }

    bufferPush(session, data);
    const newCwd = extractOsc7Cwd(data);
    const cwdMsg =
      newCwd && newCwd !== session.cwd ? JSON.stringify({ type: "cwd", path: newCwd }) : null;
    if (cwdMsg) session.cwd = newCwd!;
    for (const client of session.clients) {
      // skip backpressured/dropped clients — they catch up via buffer replay on reconnect
      if (client.send(data) < 0) continue;
      if (cwdMsg) client.send(cwdMsg);
    }
  });

  pty.onExit(() => {
    console.log(`[term] session ${sessionKey} PTY exited`);
    // Notify all clients
    const msg = new TextEncoder().encode("\r\n\x1b[33m[session ended]\x1b[0m\r\n");
    bufferPush(session, msg);
    for (const client of session.clients) {
      client.send(msg);
    }
    // Mark session as dead but keep it for replay buffer.
    // New WS clients can still connect and see the output.
    (session as any)._exited = true;
    session.onExit?.();
  });

  sessions.set(sessionKey, session);
  console.log(`[term] created session ${sessionKey} → ${cmd.join(" ")} in ${cwd}`);
  return session;
}

/** Check if a session exists */
export function hasSession(sessionKey: string): boolean {
  return sessions.has(sessionKey);
}

function bufferPush(session: Session, chunk: Uint8Array) {
  session.buffer.push(chunk);
  session.bufferBytes += chunk.length;
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    session.bufferBytes -= session.buffer.shift()!.length;
  }
}

// --- Helpers ---

function sessionName(cwd: string): string {
  return "s_" + createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}

function validateCwd(raw: string | null): string {
  if (!raw) throw new Error("cwd is required");
  const resolved = raw.replace(/\\/g, "/");
  // Allow any absolute path that doesn't traverse above root via ".."
  const isAbsolute = resolved.startsWith("/") || /^[A-Za-z]:\//.test(resolved);
  if (!isAbsolute || resolved.includes("/../")) {
    throw new Error(`invalid cwd: ${raw}`);
  }
  if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  return resolved;
}

// --- Resize debounce ---

const resizeDebounce = new Map<string, ReturnType<typeof setTimeout>>();

function applyResize(sessionKey: string) {
  clearTimeout(resizeDebounce.get(sessionKey));
  resizeDebounce.set(
    sessionKey,
    setTimeout(() => {
      const session = sessions.get(sessionKey);
      if (!session || session.clients.size === 0) return;
      // Use the most recent client's size (last resize wins)
      session.pty.resize(session.cols, session.rows);
    }, 50),
  );
}

// --- WebSocket server ---

type WSData = { url: string };

export function startTerminalWS() {
  const server = Bun.serve<WSData>({
    port: PORT,

    async fetch(req, server) {
      const url = new URL(req.url);

      // Require access key for non-loopback connections
      if (ACCESS_KEY) {
        const ip = server.requestIP(req);
        const addr = ip?.address ?? "";
        const isLocal = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
        if (!isLocal) {
          const auth = req.headers.get("authorization") ?? "";
          const key = auth.startsWith("Bearer ")
            ? auth.slice(7)
            : (url.searchParams.get("key") ?? "");
          if (key !== ACCESS_KEY) {
            return new Response("Unauthorized", { status: 401 });
          }
        }
      }

      // Internal status endpoint: GET /status/:owner/:repo
      // Returns terminal status for any session whose cwd is under <REPO_BASE>/owner/repo.
      // Route is disabled (404) when WTX_REPO_BASE env is unset.
      const statusMatch = url.pathname.match(/^\/status\/([^/]+)\/([^/]+)$/);
      if (statusMatch) {
        if (!REPO_BASE) {
          return new Response("WTX_REPO_BASE not configured", { status: 404 });
        }
        const [, owner, repo] = statusMatch;
        const repoFolder = `${REPO_BASE}/${owner}/${repo}`;
        const result = getTerminalStatusForRepo(repoFolder);
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // List all sessions: GET /sessions
      if (url.pathname === "/sessions") {
        const list = Array.from(sessions.entries()).map(([key, s]) => ({
          key,
          cwd: s.cwd,
          cmd: s.cmd,
          cols: s.cols,
          rows: s.rows,
          clients: s.clients.size,
          bufferBytes: s.bufferBytes,
          startedAt: s.startedAt,
          lastActivity: s.lastActivity,
          exited: !!(s as any)._exited,
        }));
        return new Response(JSON.stringify(list, null, 2), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Read buffered output: GET /sessions/:key/buffer[?strip=1][&tail=N]
      // ?strip=1 removes ANSI escape sequences for plain-text reading.
      // ?tail=N keeps only the last N lines of the (post-strip) output.
      const bufMatch = url.pathname.match(/^\/sessions\/([^/]+)\/buffer$/);
      if (bufMatch) {
        const session = sessions.get(bufMatch[1]);
        if (!session) return new Response("session not found", { status: 404 });
        const total = session.buffer.reduce((n, c) => n + c.length, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of session.buffer) {
          merged.set(c, off);
          off += c.length;
        }
        const tailStr = url.searchParams.get("tail");
        const tailN = tailStr ? Math.max(0, parseInt(tailStr)) : 0;
        const offsetStr = url.searchParams.get("offset");
        const offsetN = offsetStr ? Math.max(0, parseInt(offsetStr)) : 0;
        if (url.searchParams.get("strip") === "1" || tailN > 0 || offsetN > 0) {
          const text = await renderTerminalBuffer(
            merged,
            session.cols,
            session.rows,
            tailN,
            offsetN,
          );
          return new Response(text, {
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        }
        return new Response(merged, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      // Summary for a cwd: GET /summary?cwd=<path>
      // Returns TermSummary for the first session whose cwd matches (or is under) <path>.
      if (url.pathname === "/summary") {
        const cwd = url.searchParams.get("cwd") ?? "";
        if (!cwd) return new Response("missing cwd", { status: 400 });
        const result = await getTermSummaryForCwd(cwd);
        return Response.json(result);
      }

      // Git info for a session: GET /sessions/:key/git
      // Returns branch, staged/unstaged/untracked counts, and ahead/behind — same as fetchGitStatus().
      const gitMatch = url.pathname.match(/^\/sessions\/([^/]+)\/git$/);
      if (gitMatch && req.method === "GET") {
        const session = sessions.get(decodeURIComponent(gitMatch[1]));
        if (!session) return new Response("session not found", { status: 404 });
        const cwd = session.cwd;
        const git = (...args: string[]) =>
          Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
        const [branchProc, porcelainProc, abProc] = [
          git("branch", "--show-current"),
          git("status", "--porcelain"),
          git("rev-list", "--left-right", "--count", "@{u}...HEAD"),
        ];
        const [branch, porcelain, ab] = (
          await Promise.all(
            [branchProc, porcelainProc, abProc].map((p) => new Response(p.stdout).text()),
          )
        ).map((t) => t.trim());
        const lines = porcelain ? porcelain.split("\n").filter(Boolean) : [];
        const staged = lines.filter((l) => l[0] !== " " && l[0] !== "?").length;
        const unstaged = lines.filter((l) => l[1] !== " " && l[1] !== "?").length;
        const untracked = lines.filter((l) => l.startsWith("??")).length;
        let ahead = 0;
        let behind = 0;
        if (ab) {
          const [b, a] = ab.split("\t").map(Number);
          ahead = Number.isNaN(a) ? 0 : a;
          behind = Number.isNaN(b) ? 0 : b;
        }
        return Response.json({ branch, staged, unstaged, untracked, ahead, behind });
      }

      // Send input to a session: POST /sessions/:key/input
      // Body is the raw text/bytes to write to the PTY. ?cr=1 appends \r,
      // useful for `koho term send <key> "ls -la"` style invocations.
      const inputMatch = url.pathname.match(/^\/sessions\/([^/]+)\/input$/);
      if (inputMatch && req.method === "POST") {
        const session = sessions.get(inputMatch[1]);
        if (!session) return new Response("session not found", { status: 404 });
        const buf = new Uint8Array(await req.arrayBuffer());
        session.pty.write(new TextDecoder().decode(buf));
        if (url.searchParams.get("cr") === "1") session.pty.write("\r");
        return new Response("ok", { status: 200 });
      }

      // Create or delete a named session: POST /sessions/:key | DELETE /sessions/:key
      // POST body: { cmd?: string[], cwd?: string, cols?: number, rows?: number }
      // Replaces any existing session with the same key.
      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (sessionMatch) {
        const key = decodeURIComponent(sessionMatch[1]);
        if (req.method === "POST") {
          let body: { cmd?: string[]; cwd?: string; cols?: number; rows?: number } = {};
          try {
            body = (await req.json()) as typeof body;
          } catch {
            // empty/non-JSON body is OK — fall back to defaults
          }
          const cmd =
            Array.isArray(body.cmd) && body.cmd.length > 0
              ? body.cmd
              : [process.env.SHELL || "bash"];
          const cols = Math.max(MIN_COLS, body.cols ?? 80);
          const rows = Math.max(MIN_ROWS, body.rows ?? 24);
          let cwd: string;
          try {
            cwd = validateCwd(body.cwd ?? process.env.WTX_DEFAULT_CWD ?? process.cwd());
          } catch (err) {
            return new Response(err instanceof Error ? err.message : String(err), {
              status: 400,
            });
          }
          createSession(key, cmd, cols, rows, cwd);
          return Response.json({ key, cmd, cwd, cols, rows }, { status: 201 });
        }
        if (req.method === "DELETE") {
          const session = sessions.get(key);
          if (!session) return new Response("session not found", { status: 404 });
          session.pty.kill();
          sessions.delete(key);
          return new Response("ok", { status: 200 });
        }
      }

      const upgraded = server.upgrade(req, { data: { url: req.url } });
      if (!upgraded) {
        return new Response("WebSocket upgrade expected", { status: 426 });
      }
    },

    websocket: {
      open(ws) {
        const url = new URL(ws.data.url, `http://localhost:${PORT}`);
        const params = url.searchParams;

        const cols = Math.max(MIN_COLS, parseInt(params.get("cols") ?? "80"));
        const rows = Math.max(MIN_ROWS, parseInt(params.get("rows") ?? "24"));

        // ?session= attaches to a named session (e.g. agent-123)
        // ?cwd= creates/attaches to a cwd-based session
        const explicitSession = params.get("session");
        // When attaching to an existing named session, cwd is not needed
        // (and not known by the client). Otherwise, cwd is required.
        let cwd = "";
        if (!explicitSession) {
          try {
            cwd = validateCwd(params.get("cwd"));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[term] rejecting connection: ${msg}`);
            ws.send(new TextEncoder().encode(`\x1b[31m${msg}\x1b[0m\r\n`));
            ws.close(1008, msg);
            return;
          }
        }
        const sessionKey = explicitSession || sessionName(cwd);

        (ws as any)._sessionKey = sessionKey;

        // Get or create session
        let session = sessions.get(sessionKey);

        // If session exited and this is a cwd-based session, replace it with a fresh one
        if (session && (session as any)._exited && !explicitSession) {
          console.log(`[term] session ${sessionKey} exited, creating fresh session`);
          sessions.delete(sessionKey);
          session = undefined;
        }

        if (!session) {
          if (explicitSession) {
            // Named session doesn't exist — can't create it without knowing the command
            ws.send(
              new TextEncoder().encode(`\x1b[31msession "${sessionKey}" not found\x1b[0m\r\n`),
            );
            ws.close(1008, "session not found");
            return;
          }
          // Create new shell session for this cwd
          const shell = process.env.SHELL || "bash";
          session = createSession(sessionKey, [shell], cols, rows, cwd);
        }

        // Add client to session
        session.clients.add(ws);

        // Replay buffer to new client
        for (const chunk of session.buffer) {
          ws.send(chunk);
        }

        // If session has exited, don't resize — just show the replay
        if ((session as any)._exited) return;

        // Update session size
        session.cols = cols;
        session.rows = rows;
        applyResize(sessionKey);
      },

      message(ws, message) {
        const sessionKey: string = (ws as any)._sessionKey;
        const session = sessions.get(sessionKey);
        if (!session) return;

        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message);
            if (parsed.type === "resize" && parsed.cols && parsed.rows) {
              session.cols = Math.max(MIN_COLS, parsed.cols);
              session.rows = Math.max(MIN_ROWS, parsed.rows);
              applyResize(sessionKey);
              return;
            }
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong", t: parsed.t ?? Date.now() }));
              return;
            }
          } catch {
            // Not JSON — fall through to stdin
          }
          session.pty.write(message);
        } else {
          session.pty.write(new Uint8Array(message));
        }
      },

      close(ws) {
        const sessionKey: string = (ws as any)._sessionKey;
        const session = sessions.get(sessionKey);
        if (!session) return;

        session.clients.delete(ws);
        // PTY keeps running — session persists for reconnect
        console.log(
          `[term] client disconnected from ${sessionKey} (${session.clients.size} remaining)`,
        );
      },
    },
  });

  console.log(`Terminal WS server listening on port ${PORT}`);
  return server;
}

export function getTerminalStatusForRepo(repoFolder: string): {
  status: "active" | "idle" | "closed";
  lastActivity: number | null;
  cwd: string | null;
} {
  for (const session of sessions.values()) {
    if (!session.cwd.startsWith(repoFolder)) continue;
    const age = Date.now() - session.lastActivity;
    return {
      status: age < 60_000 ? "active" : "idle",
      lastActivity: session.lastActivity,
      cwd: session.cwd,
    };
  }
  return { status: "closed", lastActivity: null, cwd: null };
}

export async function getTermSummaryForCwd(cwd: string) {
  const { summarizeTerminal } = await import("./term-summary");
  for (const [sessionKey, session] of sessions.entries()) {
    if (session.cwd !== cwd && !session.cwd.startsWith(cwd + "/")) continue;
    const total = session.buffer.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of session.buffer) {
      merged.set(c, off);
      off += c.length;
    }
    const text = await renderTerminalBuffer(merged, session.cols, session.rows, 1);
    return { ...summarizeTerminal(text), sessionKey, lastActivity: session.lastActivity };
  }
  return null;
}
