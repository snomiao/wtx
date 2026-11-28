#!/usr/bin/env node
// Starts one implementation of the wtx server for a parity case, drives it
// over HTTP and WebSocket, stops it, and prints what it saw:
//
//   node rs/parity/drive.mjs <server command> [args...]
//
// in front of both implementations (`bun wtx.mjs` and the binary). wtx reads
// no arguments and never exits by itself, so the runner cannot compare it
// as a command; this script is the command the runner compares. It
//
//   1. picks a free port on 127.0.0.1 and gives the server TERMINAL_WS_PORT
//      (unless the case sets that variable: `{PORT}` in it stands for the
//      free port, so "{PORT}abc" tests what parseInt makes of it);
//   2. starts the server with the case's environment, less the PARITY_*
//      variables this script reads, and waits for its start-up line
//      ("Terminal WS server listening on port"), its end, or 15 seconds;
//   3. runs the steps of PARITY_STEPS (a JSON list, below) against it, and
//      prints each request and what came back;
//   4. closes the WebSockets it still has open, waits until the server's
//      log has been quiet for a moment, stops the server (SIGTERM; on
//      Windows taskkill /T /F, since the binary there waits for bun as a
//      child instead of becoming it), and prints how it ended and all it
//      wrote on stdout and on stderr.
//
// It exits 0 whatever the server did: the server's own exit code and
// output are part of what it prints. A server that ends before it listens
// (a start-up error, or the runner's stand-in package in the --handback
// check, whose entry prints one line and exits) skips the steps.
//
// What would differ between two runs of the same implementation is
// replaced before printing: the port by <PORT>; a number of milliseconds
// since 1970 that falls within this run by <ms>; a session key made from a
// directory this script knows (`s_` and 12 hex digits of sha256) by
// s_<sha256 of DIR>, with DIR the directory, which the runner then writes
// as <CWD> and the like; the bun that sessions run by <BUN>. Every other byte
// is printed as it came: a body or a WebSocket frame as a JSON string (so
// that escape sequences and CR LF can be read), or as hex when it is not
// UTF-8.
//
// Steps (each an object; "name" is a WebSocket's name, default "a"):
//   {"http": "GET /sessions", "body": <string or JSON value>, "headers": {...},
//    "bodyHex": "61ff", "from": "127.0.0.2"}
//        one request on a connection of its own (Connection: close); a body
//        that is not a string is sent as its JSON text, "bodyHex" as these
//        bytes. "from" is the client's own address. Prints the status,
//        Content-Type and body.
//   {"ws": "?cwd=<CWD>&cols=100", "name": "a", "path": "/", "from": ..., "headers": {...}}
//        a WebSocket handshake; prints its status (101, or the answer).
//   {"recv": "a", "until": <condition>, "timeout": 10000}
//        prints the frames the WebSocket gets until the condition holds:
//        {"type": "replay-end"} a text frame that is JSON with that type;
//        {"text": "..."} the binary frames since the step began contain it;
//        "close" the server closed it; {"quiet": 300} nothing came for 300 ms.
//        Consecutive binary frames are printed as one (how PTY output is cut
//        into chunks depends on timing).
//   {"send": "a", "text": "..."} / {"send": "a", "binary": "..."}  (UTF-8 bytes)
//   {"send": "a", "hex": "c3"}  a binary frame of these bytes
//   {"close": "a"}  closes the WebSocket from this side, and prints how the
//        server answered
//   {"wait": "<key>", "contains": "...", "timeout": 10000}
//        polls GET /sessions/<key>/buffer until it contains the text (prints
//        nothing unless it times out)
//   {"until": "log", "contains": "...", "timeout": 10000}
//        waits until the server's stdout contains the text
//   {"sleep": 100}
//   {"busy": true} occupies the port first, before the server starts (as
//        the first step only), so that the server cannot bind it
// In any string of a step, <BUN> stands for the bun on PATH and {PORT} for
// the port.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const isWindows = process.platform === "win32";
const [program, ...programArgs] = process.argv.slice(2);
if (!program) {
  console.error("usage: drive.mjs <server command> [args...]");
  process.exit(2);
}
const started = Date.now();
const steps = JSON.parse(process.env.PARITY_STEPS || "[]");
const out = [];
// Every line goes through clean() (below) when it is printed.
const say = (line) => out.push(line);

// ── the bun that sessions run, and the port ─────────────────────────────────

function which(name) {
  const exts = isWindows ? (process.env.PATHEXT || ".EXE").split(";").map((e) => e.toLowerCase()) : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}
const bun = which("bun") || "bun";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const port = await freePort();
const fill = (value) =>
  typeof value === "string"
    ? value.replaceAll("<BUN>", bun).replaceAll("{PORT}", String(port))
    : Array.isArray(value)
      ? value.map(fill)
      : value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]))
        : value;

// ── what is replaced before printing ────────────────────────────────────────

const sessionKeys = new Map();
const knowDir = (dir) => {
  for (const spelling of [dir, dir.replace(/\\/g, "/")]) {
    const key = "s_" + crypto.createHash("sha256").update(spelling).digest("hex").slice(0, 12);
    sessionKeys.set(key, `s_<sha256 of ${spelling}>`);
  }
};
knowDir(process.cwd());
const collect = (value) => {
  if (typeof value === "string") {
    for (const match of value.matchAll(/(?:^|[?&=])cwd=([^&]*)/g)) knowDir(decodeURIComponent(match[1]));
    if (/^(\/|[A-Za-z]:[\\/])/.test(value)) knowDir(value);
  } else if (value && typeof value === "object") for (const v of Object.values(value)) collect(v);
};
collect(fill(steps));
if (process.env.PARITY_DIRS) for (const dir of JSON.parse(process.env.PARITY_DIRS)) knowDir(dir);

const bunSpellings = [bun, JSON.stringify(bun).slice(1, -1)].filter((s, i, all) => all.indexOf(s) === i);
function clean(text) {
  let result = text;
  for (const spelling of bunSpellings) result = result.split(spelling).join("<BUN>");
  result = result.replace(/s_[0-9a-f]{12}/g, (key) => sessionKeys.get(key) ?? key);
  result = result.split(String(port)).join("<PORT>");
  result = result.replace(/\b1[0-9]{12}\b/g, (digits) => {
    const ms = Number(digits);
    return ms >= started - 1000 && ms <= Date.now() + 1000 ? "<ms>" : digits;
  });
  return result;
}

// The directories of this run (the case's, and the one that holds it) as a
// body may hold them inside JSON, with every backslash doubled: bun's error
// page does, on Windows. Printed as a JSON string they would be doubled
// again, a spelling the runner cannot turn back into <CWD>; so they are
// written plainly first. (Without a backslash in them, nothing changes.)
const runDirs = [process.cwd(), path.dirname(process.cwd())].filter((dir) => dir.includes("\\"));
const plainDirs = (text) => runDirs.reduce((t, dir) => t.split(JSON.stringify(dir).slice(1, -1)).join(dir), text);

/** Bytes as a JSON string when they are UTF-8, else as hex. */
function shown(bytes) {
  const buf = Buffer.from(bytes);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
    return JSON.stringify(plainDirs(text));
  } catch {
    return `hex ${buf.toString("hex")}`;
  }
}

// ── the server ──────────────────────────────────────────────────────────────

const env = { ...process.env };
for (const name of Object.keys(env)) if (name.startsWith("PARITY_")) delete env[name];
if (env.TERMINAL_WS_PORT === undefined) env.TERMINAL_WS_PORT = String(port);
else env.TERMINAL_WS_PORT = fill(env.TERMINAL_WS_PORT);

let blocker = null;
if (steps[0]?.busy) {
  blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  steps.shift();
  say("(the port is taken before the server starts)");
}

const server = spawn(program, programArgs, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const logs = { stdout: [], stderr: [] };
let lastLog = Date.now();
server.stdout.on("data", (chunk) => {
  logs.stdout.push(chunk);
  lastLog = Date.now();
});
server.stderr.on("data", (chunk) => {
  logs.stderr.push(chunk);
  lastLog = Date.now();
});
let ended = null;
const end = new Promise((resolve) => {
  server.on("error", (error) => {
    ended = `could not be started: ${error.code || error.message}`;
    resolve();
  });
  server.on("close", (code, signal) => {
    ended = signal ? `signal ${signal}` : `exit ${code}`;
    resolve();
  });
});
const stdoutText = () => Buffer.concat(logs.stdout).toString("utf8");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (test()) return true;
    if (ended) return test();
    await pause(10);
  }
  return test();
}

const listening = await until(() => /Terminal WS server listening on port .*\n/.test(stdoutText()), 15000);

// ── HTTP ────────────────────────────────────────────────────────────────────

function request({ method, target, body, bodyHex, headers = {}, from }) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, ...(from ? { localAddress: from } : {}) });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => resolve({ error: error.code || error.message }));
    socket.on("close", () => resolve({ raw: Buffer.concat(chunks) }));
    const payload =
      bodyHex !== undefined ? Buffer.from(bodyHex, "hex") : body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    if (bodyHex !== undefined) body = "";
    const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    if (body !== undefined || method === "POST") lines.push(`Content-Length: ${payload.length}`);
    socket.write(Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n"), payload]));
  });
}

function parseResponse(raw) {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) return { status: `(no complete answer: ${shown(raw)})` };
  const head = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = head[0].replace(/^HTTP\/1\.1 /, "");
  const headers = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = raw.subarray(split + 4);
  if (/chunked/i.test(headers["transfer-encoding"] || "")) {
    const parts = [];
    let at = 0;
    while (at < body.length) {
      const eol = body.indexOf("\r\n", at);
      const size = parseInt(body.subarray(at, eol).toString("latin1"), 16);
      if (!size) break;
      parts.push(body.subarray(eol + 2, eol + 2 + size));
      at = eol + 2 + size + 2;
    }
    body = Buffer.concat(parts);
  }
  return { status, headers, body };
}

async function http(step) {
  const [method, target] = step.http.split(" ");
  const sent = step.bodyHex !== undefined ? ` hex ${step.bodyHex}` : step.body === undefined ? "" : ` ${JSON.stringify(step.body)}`;
  const extra = step.headers ? ` ${JSON.stringify(step.headers)}` : "";
  say(`> ${method} ${target}${sent}${extra}${step.from ? ` (from ${step.from})` : ""}`);
  const answer = await request({ method, target, body: step.body, bodyHex: step.bodyHex, headers: step.headers, from: step.from });
  if (answer.error) return say(`< (no answer: ${answer.error})`);
  const { status, headers, body } = parseResponse(answer.raw);
  if (!headers) return say(`< ${status}`);
  say(`< ${status}; content-type: ${headers["content-type"] ?? "(none)"}`);
  say(`  ${shown(body)}`);
  return body;
}

// ── WebSocket ───────────────────────────────────────────────────────────────

const sockets = new Map();

function openSocket(step) {
  const name = step.name || "a";
  const target = `${step.path || "/"}${step.ws}`;
  say(`ws ${name}: open ${target}${step.from ? ` (from ${step.from})` : ""}`);
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, ...(step.from ? { localAddress: step.from } : {}) });
    const key = crypto.randomBytes(16).toString("base64");
    const ws = { name, socket, pending: Buffer.alloc(0), frames: [], closed: null, handshake: null, fragments: null };
    sockets.set(name, ws);
    socket.on("error", (error) => {
      if (!ws.handshake) {
        say(`ws ${name}: (no answer: ${error.code || error.message})`);
        resolve();
      }
      ws.closed ??= `error ${error.code || error.message}`;
    });
    socket.on("close", () => {
      ws.closed ??= "connection closed without a close frame";
      if (!ws.handshake) {
        const answer = parseResponse(ws.pending);
        say(`ws ${name}: < ${answer.status}${answer.body ? ` ${shown(answer.body)}` : ""}`);
        resolve();
      }
    });
    socket.on("data", (chunk) => {
      ws.pending = Buffer.concat([ws.pending, chunk]);
      if (!ws.handshake) {
        const split = ws.pending.indexOf("\r\n\r\n");
        if (split < 0) return;
        const head = ws.pending.subarray(0, split).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) return; // the rest comes with the close
        const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        ws.handshake = head.includes(accept) ? "101" : "101 with a wrong Sec-WebSocket-Accept";
        say(`ws ${name}: < ${ws.handshake}`);
        ws.pending = ws.pending.subarray(split + 4);
        resolve();
      }
      readFrames(ws);
    });
    const lines = [
      `GET ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ];
    for (const [header, value] of Object.entries(step.headers || {})) lines.push(`${header}: ${value}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
  });
}

function readFrames(ws) {
  for (;;) {
    const data = ws.pending;
    if (data.length < 2) return;
    const fin = (data[0] & 0x80) !== 0;
    const opcode = data[0] & 0x0f;
    let length = data[1] & 0x7f;
    let at = 2;
    if (length === 126) {
      if (data.length < 4) return;
      length = data.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (data.length < 10) return;
      length = Number(data.readBigUInt64BE(2));
      at = 10;
    }
    if (data[1] & 0x80) at += 4; // a server does not mask; skip a mask all the same
    if (data.length < at + length) return;
    const payload = data.subarray(at, at + length);
    ws.pending = data.subarray(at + length);
    if (opcode === 9) {
      sendFrame(ws, 10, payload);
      continue;
    }
    if (opcode === 10) continue;
    if (opcode === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
      const reason = payload.subarray(2).toString("utf8");
      ws.frames.push({ close: code === null ? "close (no code)" : `close ${code} ${JSON.stringify(reason)}` });
      if (!ws.closing) sendFrame(ws, 8, payload.subarray(0, 2));
      ws.closed ??= "closed by the server";
      continue;
    }
    if (opcode === 0 && ws.fragments) {
      ws.fragments.parts.push(payload);
      if (!fin) continue;
      const whole = Buffer.concat(ws.fragments.parts);
      ws.frames.push(ws.fragments.opcode === 1 ? { text: whole.toString("utf8") } : { binary: whole });
      ws.fragments = null;
      continue;
    }
    if (!fin) {
      ws.fragments = { opcode, parts: [payload] };
      continue;
    }
    ws.frames.push(opcode === 1 ? { text: payload.toString("utf8") } : { binary: Buffer.from(payload) });
  }
}

function sendFrame(ws, opcode, payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length]) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (length >= 126 && length < 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else if (length >= 65536) {
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  try {
    ws.socket.write(Buffer.concat([head, mask, masked]));
  } catch {}
}

/** Prints the frames a WebSocket got since they were last printed: binary frames in a row as one. */
function flush(ws, upTo = ws.frames.length) {
  const frames = ws.frames.splice(0, upTo);
  let bytes = null;
  const flushBytes = () => {
    if (bytes) say(`  ${ws.name} binary ${shown(Buffer.concat(bytes))}`);
    bytes = null;
  };
  for (const frame of frames) {
    if (frame.binary) {
      (bytes ??= []).push(frame.binary);
      continue;
    }
    flushBytes();
    if (frame.text !== undefined) say(`  ${ws.name} text ${frame.text}`);
    else say(`  ${ws.name} ${frame.close}`);
  }
  flushBytes();
}

async function recv(step) {
  const ws = sockets.get(step.recv);
  if (!ws) return say(`recv ${step.recv}: no such WebSocket`);
  const condition = step.until;
  const timeout = step.timeout ?? 10000;
  const textOf = () =>
    Buffer.concat(ws.frames.filter((f) => f.binary).map((f) => f.binary)).toString("utf8");
  let met;
  if (condition === "close") met = await until(() => ws.frames.some((f) => f.close) || ws.closed, timeout);
  else if (condition?.type) {
    met = await until(() => ws.frames.some((f) => f.text !== undefined && typeOf(f.text) === condition.type), timeout);
  } else if (condition?.text !== undefined) met = await until(() => textOf().includes(condition.text), timeout);
  else if (condition?.quiet) {
    let seen = -1;
    let since = Date.now();
    met = await until(() => {
      if (ws.frames.length !== seen) {
        seen = ws.frames.length;
        since = Date.now();
      }
      return Date.now() - since >= condition.quiet;
    }, timeout);
  } else met = true;
  if (condition?.type) {
    // Only up to the frame looked for: what follows belongs to the next step.
    const at = ws.frames.findIndex((f) => f.text !== undefined && typeOf(f.text) === condition.type);
    flush(ws, at < 0 ? ws.frames.length : at + 1);
  } else flush(ws);
  if (!met) say(`  ${ws.name}: (nothing more within ${timeout} ms)`);
}

function typeOf(text) {
  try {
    return JSON.parse(text)?.type;
  } catch {
    return undefined;
  }
}

async function closeSocket(name, quiet = false) {
  const ws = sockets.get(name);
  if (!ws || !ws.handshake) return;
  if (!ws.closed) {
    ws.closing = true;
    sendFrame(ws, 8, Buffer.from([0x03, 0xe8]));
    await until(() => ws.frames.some((f) => f.close) || ws.closed, 3000);
    ws.socket.end();
  }
  if (!quiet) {
    say(`ws ${name}: closed from this side`);
    flush(ws);
  }
  sockets.delete(name);
}

// ── the steps ───────────────────────────────────────────────────────────────

if (listening && !ended) {
  for (const raw of steps) {
    const step = fill(raw);
    if (ended) break;
    if (step.http) await http(step);
    else if (step.ws !== undefined) await openSocket(step);
    else if (step.recv) await recv(step);
    else if (step.send) {
      const ws = sockets.get(step.send);
      if (!ws) say(`send ${step.send}: no such WebSocket`);
      else if (step.text !== undefined) sendFrame(ws, 1, Buffer.from(step.text));
      else if (step.hex !== undefined) sendFrame(ws, 2, Buffer.from(step.hex, "hex"));
      else sendFrame(ws, 2, Buffer.from(step.binary));
    } else if (step.close) await closeSocket(step.close);
    else if (step.wait) {
      const deadline = Date.now() + (step.timeout ?? 10000);
      let seen = false;
      while (!seen && Date.now() < deadline && !ended) {
        const answer = await request({ method: "GET", target: `/sessions/${step.wait}/buffer` });
        seen = !!answer.raw && parseResponse(answer.raw).body?.toString("utf8").includes(step.contains);
        if (!seen) await pause(20);
      }
      if (!seen) say(`(the buffer of ${step.wait} did not come to contain ${JSON.stringify(step.contains)})`);
    } else if (step.until === "log") {
      if (!(await until(() => stdoutText().includes(step.contains), step.timeout ?? 10000))) {
        say(`(the server's stdout did not come to contain ${JSON.stringify(step.contains)})`);
      }
    } else if (step.sleep) await pause(step.sleep);
    else say(`(a step this script does not know: ${JSON.stringify(raw)})`);
  }
  for (const name of [...sockets.keys()]) await closeSocket(name, true);
}

// ── the end ─────────────────────────────────────────────────────────────────

if (!ended) {
  if (!listening) say("(the server did not say it was listening within 15 s)");
  // Whatever the server still writes about the last steps.
  await until(() => Date.now() - lastLog >= 300, 3000);
  if (isWindows) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGTERM");
  const stopped = await Promise.race([end.then(() => true), pause(10000).then(() => false)]);
  if (!stopped) {
    server.kill("SIGKILL");
    await end;
  }
  say(`server stopped: ${isWindows ? "(killed)" : ended}`);
} else {
  await end;
  say(`server ended by itself before ${listening ? "the steps were done" : "it listened"}: ${ended}`);
}
blocker?.close();
for (const stream of ["stdout", "stderr"]) {
  const text = Buffer.concat(logs[stream]).toString("utf8");
  say(`--- server ${stream}${text ? "" : " (empty)"}`);
  if (text) say(text.replace(/\n$/, ""));
}
process.stdout.write(out.map(clean).join("\n") + "\n");
