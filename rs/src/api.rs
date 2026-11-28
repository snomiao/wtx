//! The server's handlers: what `startTerminalWS` answers over HTTP and does
//! on a WebSocket, with `createSession`, the resize debounce and bun-pty's
//! Terminal, as one state machine over a table of sessions.
//!
//! Everything around it is a stand-in the caller provides ([`World`]): the
//! clock, process.env, the file system's answer to existsSync, bun-pty's
//! native side (spawning a program and what it returns), git, and what
//! `ws.send` returns. Each event ([`Server::fetch`], [`Server::ws_open`],
//! [`Server::ws_message`], [`Server::ws_close`], [`Server::pty_data`],
//! [`Server::pty_exit`], [`Server::advance`]) leaves its effects in
//! [`Server::effects`], in the order the TypeScript has them.
//!
//! The HTTP layer, the WebSocket framing, URL parsing and the PTYs are not
//! here; neither is rendering a screen (the caller gets
//! [`Outcome::Render`] and [`Outcome::Summary`] to do that). Where the
//! TypeScript would throw, and bun answer in its own words (a development
//! error page, a crashed server), the handler says [`Outcome::Unported`]:
//! a native server would first need those.
//!
//! Tested against src/server.ts itself, event by event, on generated
//! scenarios (rs/parity/record.ts, rs/src/testdata/scenarios.json).

use crate::js::{self, Json, Parsed};
use crate::server::{self, ReplayBuffer, TermSize, MIN_COLS, MIN_ROWS};
use std::collections::BTreeMap;

/// What the module reads once, when it is loaded.
#[derive(Debug, Clone)]
pub struct Config {
    /// `process.env.TERMINAL_ACCESS_KEY ?? ""`.
    pub access_key: String,
    /// `process.env.WTX_REPO_BASE ?? ""`.
    pub repo_base: String,
    /// `os.hostname()`.
    pub hostname: String,
    /// `join(tmpdir(), "koho-term-zshrc")`.
    pub zdotdir: String,
}

/// The surroundings of the server.
pub trait World {
    /// `Date.now()`.
    fn now(&self) -> f64;
    /// `process.env[name]`, at the moment it is read.
    fn env(&self, name: &str) -> Option<String>;
    /// `Object.entries(process.env)`.
    fn env_list(&self) -> Vec<(String, String)>;
    /// `process.cwd()`.
    fn cwd(&self) -> String;
    /// `existsSync(path)`.
    fn exists(&self, path: &str) -> bool;
    /// bun-pty's native `bun_pty_spawn`: false where it fails (the program
    /// does not exist, a size it cannot take).
    fn spawn_succeeds(&self, cmdline: &str, cols: f64, rows: f64) -> bool;
    /// What `git -C <cwd> <args>` prints on stdout.
    fn git(&self, cwd: &str, args: &str) -> String;
    /// What `ws.send` returns for this client: below 0 when it is backed up.
    fn send_result(&self, client: usize) -> f64;
}

/// A request as `fetch` sees it.
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// `new URL(req.url).pathname` and `.search`.
    pub pathname: String,
    pub search: String,
    /// `req.headers.get("authorization")`.
    pub authorization: Option<String>,
    /// Whether Bun.serve's `server.upgrade` takes it (a WebSocket handshake).
    pub websocket: bool,
    pub body: Vec<u8>,
    /// `server.requestIP(req)?.address`.
    pub ip: String,
}

/// What `fetch` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Response { status: u16, content_type: &'static str, body: Vec<u8> },
    /// `renderTerminalBuffer(data, cols, rows, tail, offset)`, answered as
    /// text/plain; charset=utf-8.
    Render { data: Vec<u8>, cols: f64, rows: f64, tail: usize, offset: usize },
    /// `/summary`: `renderTerminalBuffer(data, cols, rows, 1)`, summarised,
    /// with `sessionKey` and `lastActivity` after the summary's fields.
    Summary { data: Vec<u8>, cols: f64, rows: f64, session_key: String, last_activity: f64 },
    /// The request became the WebSocket of this client (ws_open follows).
    Upgrade { client: usize },
    /// The TypeScript throws here, or does something this module does not
    /// reproduce; the reason says which.
    Unported(&'static str),
}

/// A frame for a client.
#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

/// What the server does to its surroundings, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Stdout(String),
    Stderr(String),
    Mkdir(String),
    Spawn { pty: usize, cmdline: String, cwd: String, cols: f64, rows: f64, env: Vec<(String, String)> },
    SpawnFailed { cmdline: String },
    PtyWrite { pty: usize, bytes: Vec<u8> },
    PtyResize { pty: usize, cols: f64, rows: f64 },
    PtyKill { pty: usize },
    Git { args: String, cwd: String },
    Send { client: usize, frame: Frame },
    Close { client: usize, code: u16, reason: String },
}

/// bun-pty's Terminal, as far as the server can tell.
#[derive(Debug, Default)]
struct Pty {
    /// `_closing`: set by kill; writes, resizes and kills do nothing after it,
    /// and the read loop has stopped.
    closing: bool,
    /// The read loop has seen the program end (it stays open to kill).
    ended: bool,
    decoder: js::StreamDecoder,
    /// The session whose onData and onExit listen.
    session: usize,
}

#[derive(Debug)]
struct Session {
    key: String,
    pty: usize,
    buffer: ReplayBuffer,
    /// Clients in the order they were added (a JavaScript Set).
    clients: Vec<usize>,
    cols: f64,
    rows: f64,
    cmd: Vec<String>,
    cwd: String,
    started_at: f64,
    last_activity: f64,
    exited: bool,
}

#[derive(Debug, Default)]
struct Client {
    /// `ws.data.url`'s search.
    search: String,
    /// `ws._sessionKey`.
    session_key: Option<String>,
    /// `ws._cap`.
    cap: Option<TermSize>,
}

/// The server: its sessions, clients, PTYs and timers.
pub struct Server {
    config: Config,
    /// Every session object ever made; the map below names the live ones.
    sessions: Vec<Session>,
    /// `sessions`, the Map: key → session, in insertion order.
    table: Vec<(String, usize)>,
    ptys: Vec<Pty>,
    clients: Vec<Client>,
    /// `resizeDebounce`: one timer per key, (due, order, key).
    timers: BTreeMap<String, (f64, u64)>,
    timer_order: u64,
    pub effects: Vec<Effect>,
}

/// `[session ended]`, as the PTY's end adds it to the buffer and the clients.
pub const SESSION_ENDED: &[u8] = b"\r\n\x1b[33m[session ended]\x1b[0m\r\n";

fn text_response(status: u16, text: &str) -> Outcome {
    Outcome::Response { status, content_type: "text/plain;charset=utf-8", body: text.as_bytes().to_vec() }
}

fn json_response(status: u16, text: String) -> Outcome {
    Outcome::Response { status, content_type: "application/json;charset=utf-8", body: text.into_bytes() }
}

/// `/^\/<prefix>\/([^/]+)<suffix>$/`: the segment, if the path is that.
fn one_segment<'a>(path: &'a str, prefix: &str, suffix: &str) -> Option<&'a str> {
    let rest = path.strip_prefix(prefix)?.strip_suffix(suffix)?;
    (!rest.is_empty() && !rest.contains('/')).then_some(rest)
}

impl Server {
    pub fn new(config: Config) -> Self {
        Server { config, sessions: Vec::new(), table: Vec::new(), ptys: Vec::new(), clients: Vec::new(), timers: BTreeMap::new(), timer_order: 0, effects: Vec::new() }
    }

    fn live(&self, key: &str) -> Option<usize> {
        self.table.iter().find(|(k, _)| k == key).map(|(_, id)| *id)
    }

    fn forget(&mut self, key: &str) {
        self.table.retain(|(k, _)| k != key);
    }

    fn send(&mut self, world: &dyn World, client: usize, frame: Frame) -> f64 {
        self.effects.push(Effect::Send { client, frame });
        world.send_result(client)
    }

    // ── bun-pty's Terminal ─────────────────────────────────────────────

    fn pty_write(&mut self, pty: usize, text: &str) {
        if self.ptys[pty].closing {
            return;
        }
        self.effects.push(Effect::PtyWrite { pty, bytes: text.as_bytes().to_vec() });
    }

    fn pty_resize(&mut self, pty: usize, cols: f64, rows: f64) {
        if self.ptys[pty].closing {
            return;
        }
        self.effects.push(Effect::PtyResize { pty, cols, rows });
    }

    /// `kill()`: once; the exit is reported at once, whether or not the
    /// program had ended already.
    fn pty_kill(&mut self, world: &dyn World, pty: usize) -> Result<(), &'static str> {
        if self.ptys[pty].closing {
            return Ok(());
        }
        self.ptys[pty].closing = true;
        self.effects.push(Effect::PtyKill { pty });
        let session = self.ptys[pty].session;
        self.on_exit(world, session)
    }

    /// What the program printed: bun-pty reads at most 4096 bytes at a time
    /// and decodes them as one stream of UTF-8; each piece that decodes to
    /// some text reaches the server.
    pub fn pty_data(&mut self, world: &dyn World, pty: usize, bytes: &[u8]) -> Result<(), &'static str> {
        for read in bytes.chunks(4096) {
            let state = &mut self.ptys[pty];
            if state.closing || state.ended {
                return Ok(());
            }
            let text = state.decoder.decode(read);
            if !text.is_empty() {
                let session = state.session;
                self.on_data(world, session, text.as_bytes())?;
            }
        }
        Ok(())
    }

    /// The program ended: what the decoder still holds, then the exit.
    pub fn pty_exit(&mut self, world: &dyn World, pty: usize) -> Result<(), &'static str> {
        let state = &mut self.ptys[pty];
        if state.closing || state.ended {
            return Ok(());
        }
        state.ended = true;
        let rest = state.decoder.finish();
        let session = state.session;
        if !rest.is_empty() {
            self.on_data(world, session, rest.as_bytes())?;
        }
        self.on_exit(world, session)
    }

    // ── createSession and its listeners ────────────────────────────────

    /// `createSession(key, cmd, cols, rows, cwd)`.
    fn create_session(&mut self, world: &dyn World, key: &str, cmd: Vec<String>, cols: f64, rows: f64, cwd: String) -> Result<usize, &'static str> {
        if let Some(existing) = self.live(key) {
            self.effects.push(Effect::Stdout(format!("[term] replacing existing session {key}")));
            let pty = self.sessions[existing].pty;
            self.pty_kill(world, pty)?;
            self.forget(key);
        }
        // spawnPty
        let line = server::spawn_line(&cmd, cols, rows, &cwd).ok_or("a size whose JavaScript spelling is not reproduced")?;
        self.effects.push(Effect::Stdout(line));
        let cmdline: Vec<String> = cmd.iter().map(|c| server::sh_quote(c)).collect();
        let cmdline = cmdline.join(" ");
        if !world.spawn_succeeds(&cmdline, cols, rows) {
            self.effects.push(Effect::SpawnFailed { cmdline });
            return Err("bun-pty throws `PTY spawn failed`");
        }
        let env = server::pty_env(&world.env_list(), &self.config.hostname, &self.config.zdotdir);
        let pty = self.ptys.len();
        let id = self.sessions.len();
        self.ptys.push(Pty { session: id, ..Pty::default() });
        self.effects.push(Effect::Spawn { pty, cmdline, cwd: cwd.clone(), cols, rows, env });
        let now = world.now();
        self.sessions.push(Session { key: key.to_string(), pty, buffer: ReplayBuffer::default(), clients: Vec::new(), cols, rows, cmd: cmd.clone(), cwd: cwd.clone(), started_at: now, last_activity: now, exited: false });
        self.table.push((key.to_string(), id));
        self.effects.push(Effect::Stdout(format!("[term] created session {key} → {} in {cwd}", cmd.join(" "))));
        Ok(id)
    }

    fn on_data(&mut self, world: &dyn World, id: usize, data: &[u8]) -> Result<(), &'static str> {
        self.sessions[id].last_activity = world.now();
        let pty = self.sessions[id].pty;
        for reply in server::query_replies(data) {
            self.pty_write(pty, reply);
        }
        self.sessions[id].buffer.push(data.to_vec());
        let cwd_message = match server::osc7_cwd(data) {
            Some(path) if !path.is_empty() && path != self.sessions[id].cwd => {
                let message = format!("{{\"type\":\"cwd\",\"path\":{}}}", js::json_string(&path));
                self.sessions[id].cwd = path;
                Some(message)
            }
            _ => None,
        };
        for client in self.sessions[id].clients.clone() {
            if self.send(world, client, Frame::Binary(data.to_vec())) < 0.0 {
                continue;
            }
            if let Some(message) = &cwd_message {
                self.send(world, client, Frame::Text(message.clone()));
            }
        }
        Ok(())
    }

    fn on_exit(&mut self, world: &dyn World, id: usize) -> Result<(), &'static str> {
        let key = self.sessions[id].key.clone();
        self.effects.push(Effect::Stdout(format!("[term] session {key} PTY exited")));
        self.sessions[id].buffer.push(SESSION_ENDED.to_vec());
        for client in self.sessions[id].clients.clone() {
            self.send(world, client, Frame::Binary(SESSION_ENDED.to_vec()));
        }
        self.sessions[id].exited = true;
        Ok(())
    }

    // ── the resize debounce ────────────────────────────────────────────

    /// `applyResize(key)`: (re)starts the key's 50 ms timer.
    fn apply_resize(&mut self, world: &dyn World, key: &str) {
        self.timer_order += 1;
        self.timers.insert(key.to_string(), (world.now() + 50.0, self.timer_order));
    }

    /// The clock has moved on: the timers that are due fire, in the order
    /// they were set.
    pub fn advance(&mut self, world: &dyn World) {
        let now = world.now();
        let mut due: Vec<(f64, u64, String)> = self.timers.iter().filter(|(_, (at, _))| *at <= now).map(|(k, (at, order))| (*at, *order, k.clone())).collect();
        due.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        for (_, _, key) in due {
            self.timers.remove(&key);
            self.resize_now(world, &key);
        }
    }

    fn resize_now(&mut self, world: &dyn World, key: &str) {
        let Some(id) = self.live(key) else { return };
        if self.sessions[id].clients.is_empty() || self.sessions[id].exited {
            return;
        }
        let caps: Vec<TermSize> = self.sessions[id].clients.iter().filter_map(|c| self.clients[*c].cap).collect();
        let session = &self.sessions[id];
        let next = server::negotiate_size(&caps, TermSize { cols: session.cols, rows: session.rows });
        if next.cols == session.cols && next.rows == session.rows {
            return;
        }
        self.sessions[id].cols = next.cols;
        self.sessions[id].rows = next.rows;
        let pty = self.sessions[id].pty;
        self.pty_resize(pty, next.cols, next.rows);
        let Some(message) = size_frame(next.cols, next.rows) else { return };
        for client in self.sessions[id].clients.clone() {
            self.send(world, client, Frame::Text(message.clone()));
        }
    }

    // ── fetch ──────────────────────────────────────────────────────────

    /// The `fetch` handler of Bun.serve.
    pub fn fetch(&mut self, world: &dyn World, req: &Request) -> Outcome {
        match self.fetch_inner(world, req) {
            Ok(outcome) => outcome,
            Err(reason) => Outcome::Unported(reason),
        }
    }

    fn fetch_inner(&mut self, world: &dyn World, req: &Request) -> Result<Outcome, &'static str> {
        let params = js::search_params(&req.search);
        let param = |name: &str| js::search_param(&params, name);
        let path = req.pathname.as_str();

        if !self.config.access_key.is_empty() {
            let local = matches!(req.ip.as_str(), "127.0.0.1" | "::1" | "::ffff:127.0.0.1");
            if !local {
                let auth = req.authorization.as_deref().unwrap_or("");
                let key = match auth.strip_prefix("Bearer ") {
                    Some(key) => key,
                    None => param("key").unwrap_or(""),
                };
                if key != self.config.access_key {
                    return Ok(text_response(401, "Unauthorized"));
                }
            }
        }

        // /^\/status\/([^/]+)\/([^/]+)$/
        if let Some(rest) = path.strip_prefix("/status/") {
            if let Some((owner, repo)) = rest.split_once('/') {
                if !owner.is_empty() && !repo.is_empty() && !repo.contains('/') {
                    if self.config.repo_base.is_empty() {
                        return Ok(text_response(404, "WTX_REPO_BASE not configured"));
                    }
                    let folder = format!("{}/{owner}/{repo}", self.config.repo_base);
                    let views: Vec<server::SessionView> = self.table.iter().map(|(_, id)| server::SessionView { cwd: &self.sessions[*id].cwd, last_activity: self.sessions[*id].last_activity }).collect();
                    let body = server::status_for_repo(&views, &folder, world.now()).ok_or("a time whose JavaScript spelling is not reproduced")?;
                    return Ok(Outcome::Response { status: 200, content_type: "application/json", body: body.into_bytes() });
                }
            }
        }

        if path == "/sessions" {
            let body = self.sessions_json().ok_or("a size whose JavaScript spelling is not reproduced")?;
            return Ok(Outcome::Response { status: 200, content_type: "application/json", body: body.into_bytes() });
        }

        if let Some(key) = one_segment(path, "/sessions/", "/buffer") {
            let Some(id) = self.live(key) else { return Ok(text_response(404, "session not found")) };
            let data = self.sessions[id].buffer.merged();
            // tailStr ? Math.max(0, parseInt(tailStr)) : 0
            let count = |name: &str| -> Result<f64, &'static str> {
                match param(name) {
                    None | Some("") => Ok(0.0),
                    Some(text) => Ok(server::js_max(0.0, js::parse_int(text).ok_or("a count parseInt reads beyond 15 digits")?)),
                }
            };
            let (tail, offset) = (count("tail")?, count("offset")?);
            if param("strip") == Some("1") || tail > 0.0 || offset > 0.0 {
                let whole = |x: f64| if x > 0.0 { x as usize } else { 0 };
                let session = &self.sessions[id];
                return Ok(Outcome::Render { data, cols: session.cols, rows: session.rows, tail: whole(tail), offset: whole(offset) });
            }
            return Ok(Outcome::Response { status: 200, content_type: "application/octet-stream", body: data });
        }

        if path == "/summary" {
            let cwd = param("cwd").unwrap_or("");
            if cwd.is_empty() {
                return Ok(text_response(400, "missing cwd"));
            }
            let views: Vec<server::SessionView> = self.table.iter().map(|(_, id)| server::SessionView { cwd: &self.sessions[*id].cwd, last_activity: 0.0 }).collect();
            return Ok(match server::summary_session(&views, cwd) {
                None => json_response(200, "null".into()),
                Some(at) => {
                    let (key, id) = self.table[at].clone();
                    let session = &self.sessions[id];
                    Outcome::Summary { data: session.buffer.merged(), cols: session.cols, rows: session.rows, session_key: key, last_activity: session.last_activity }
                }
            });
        }

        if let Some(raw) = one_segment(path, "/sessions/", "/git") {
            if req.method == "GET" {
                let key = js::decode_uri_component(raw).ok_or("decodeURIComponent throws a URIError")?;
                let Some(id) = self.live(&key) else { return Ok(text_response(404, "session not found")) };
                let cwd = self.sessions[id].cwd.clone();
                let mut outputs = Vec::new();
                for args in ["branch --show-current", "status --porcelain", "rev-list --left-right --count @{u}...HEAD"] {
                    self.effects.push(Effect::Git { args: args.into(), cwd: cwd.clone() });
                    outputs.push(js::trim(&world.git(&cwd, args)).to_string());
                }
                return Ok(json_response(200, git_json(&outputs[0], &outputs[1], &outputs[2]).ok_or("a count whose JavaScript spelling is not reproduced")?));
            }
        }

        if let Some(key) = one_segment(path, "/sessions/", "/input") {
            if req.method == "POST" {
                let Some(id) = self.live(key) else { return Ok(text_response(404, "session not found")) };
                let pty = self.sessions[id].pty;
                self.pty_write(pty, &js::text_decode(&req.body));
                if param("cr") == Some("1") {
                    self.pty_write(pty, "\r");
                }
                return Ok(text_response(200, "ok"));
            }
        }

        if let Some(raw) = one_segment(path, "/sessions/", "") {
            let key = js::decode_uri_component(raw).ok_or("decodeURIComponent throws a URIError")?;
            if req.method == "POST" {
                return self.post_session(world, &key, &req.body);
            }
            if req.method == "DELETE" {
                let Some(id) = self.live(&key) else { return Ok(text_response(404, "session not found")) };
                let pty = self.sessions[id].pty;
                self.pty_kill(world, pty)?;
                self.forget(&key);
                return Ok(text_response(200, "ok"));
            }
        }

        if req.websocket {
            let client = self.clients.len();
            self.clients.push(Client { search: req.search.clone(), ..Client::default() });
            return Ok(Outcome::Upgrade { client });
        }
        Ok(text_response(426, "WebSocket upgrade expected"))
    }

    /// POST /sessions/:key.
    fn post_session(&mut self, world: &dyn World, key: &str, body: &[u8]) -> Result<Outcome, &'static str> {
        // `await req.json()`, and {} for a body that is not JSON.
        let body = match js::json_parse(&js::text_decode(body)) {
            Parsed::Value(value) => value,
            Parsed::Invalid => Json::Object(Vec::new()),
            Parsed::Unsupported => return Err("JSON that this module does not parse as JSON.parse does"),
        };
        if body == Json::Null {
            return Err("`body.cmd` of null throws a TypeError");
        }
        let cmd: Vec<String> = match body.get("cmd") {
            Some(Json::Array(items)) if !items.is_empty() => items.iter().map(|item| if let Json::String(s) = item { Ok(s.clone()) } else { Err("a cmd that is not all strings") }).collect::<Result<_, _>>()?,
            _ => vec![world.env("SHELL").filter(|s| !s.is_empty()).unwrap_or_else(|| "bash".into())],
        };
        // Math.max(MIN, body.x ?? default)
        let size = |name: &str, min: f64, default: f64| -> Result<f64, &'static str> {
            let value = match body.get(name) {
                None | Some(Json::Null) => default,
                Some(value) => value.to_number().ok_or("a size that is an array or an object")?,
            };
            Ok(server::js_max(min, value))
        };
        let cols = size("cols", MIN_COLS, 80.0)?;
        let rows = size("rows", MIN_ROWS, 24.0)?;
        // body.cwd ?? process.env.WTX_DEFAULT_CWD ?? process.cwd()
        let raw = match body.get("cwd") {
            None | Some(Json::Null) => Some(world.env("WTX_DEFAULT_CWD").unwrap_or_else(|| world.cwd())),
            Some(Json::String(s)) => Some(s.clone()),
            Some(value) if !value.truthy() => None,
            Some(_) => return Err("a cwd that is not a string: JavaScriptCore's own TypeError message"),
        };
        let cwd = match server::validate_cwd(raw.as_deref(), |p| world.exists(p)) {
            Ok((cwd, make)) => {
                if make {
                    self.effects.push(Effect::Mkdir(cwd.clone()));
                }
                cwd
            }
            Err(message) => return Ok(text_response(400, &message)),
        };
        self.create_session(world, key, cmd.clone(), cols, rows, cwd.clone())?;
        let cmd_json: Vec<String> = cmd.iter().map(|c| js::json_string(c)).collect();
        let number = |x: f64| js::json_number(x).ok_or("a size whose JavaScript spelling is not reproduced");
        Ok(json_response(
            201,
            format!("{{\"key\":{},\"cmd\":[{}],\"cwd\":{},\"cols\":{},\"rows\":{}}}", js::json_string(key), cmd_json.join(","), js::json_string(&cwd), number(cols)?, number(rows)?),
        ))
    }

    /// `JSON.stringify(list, null, 2)` of GET /sessions.
    fn sessions_json(&self) -> Option<String> {
        if self.table.is_empty() {
            return Some("[]".into());
        }
        let mut items = Vec::new();
        for (key, id) in &self.table {
            let s = &self.sessions[*id];
            let cmd: Vec<String> = s.cmd.iter().map(|c| format!("      {}", js::json_string(c))).collect();
            items.push(format!(
                "  {{\n    \"key\": {},\n    \"cwd\": {},\n    \"cmd\": [\n{}\n    ],\n    \"cols\": {},\n    \"rows\": {},\n    \"clients\": {},\n    \"bufferBytes\": {},\n    \"startedAt\": {},\n    \"lastActivity\": {},\n    \"exited\": {}\n  }}",
                js::json_string(key),
                js::json_string(&s.cwd),
                cmd.join(",\n"),
                js::json_number(s.cols)?,
                js::json_number(s.rows)?,
                s.clients.len(),
                s.buffer.bytes,
                js::json_number(s.started_at)?,
                js::json_number(s.last_activity)?,
                s.exited
            ));
        }
        Some(format!("[\n{}\n]", items.join(",\n")))
    }

    // ── the websocket handlers ─────────────────────────────────────────

    /// `websocket.open`, after `fetch` said [`Outcome::Upgrade`].
    pub fn ws_open(&mut self, world: &dyn World, client: usize) -> Result<(), &'static str> {
        let params = js::search_params(&self.clients[client].search);
        let param = |name: &str| js::search_param(&params, name).map(str::to_string);
        // Math.max(MIN, parseInt(params.get(x) ?? default))
        let size = |name: &str, min: f64, default: &str| -> Result<f64, &'static str> {
            Ok(server::js_max(min, js::parse_int(&param(name).unwrap_or_else(|| default.into())).ok_or("a size parseInt reads beyond 15 digits")?))
        };
        let cols = size("cols", MIN_COLS, "80")?;
        let rows = size("rows", MIN_ROWS, "24")?;
        let explicit = param("session").filter(|s| !s.is_empty());
        let mut cwd = String::new();
        if explicit.is_none() {
            match server::validate_cwd(param("cwd").as_deref(), |p| world.exists(p)) {
                Ok((resolved, make)) => {
                    if make {
                        self.effects.push(Effect::Mkdir(resolved.clone()));
                    }
                    cwd = resolved;
                }
                Err(message) => {
                    if message.len() > 123 {
                        return Err("a close reason longer than a WebSocket close frame holds");
                    }
                    self.effects.push(Effect::Stderr(format!("[term] rejecting connection: {message}")));
                    self.send(world, client, Frame::Binary(format!("\x1b[31m{message}\x1b[0m\r\n").into_bytes()));
                    self.effects.push(Effect::Close { client, code: 1008, reason: message });
                    return Ok(());
                }
            }
        }
        let key = explicit.clone().unwrap_or_else(|| server::session_name(&cwd));
        self.clients[client].session_key = Some(key.clone());
        let mut session = self.live(&key);
        if let Some(id) = session {
            if self.sessions[id].exited && explicit.is_none() {
                self.effects.push(Effect::Stdout(format!("[term] session {key} exited, creating fresh session")));
                self.forget(&key);
                session = None;
            }
        }
        let id = match session {
            Some(id) => id,
            None => {
                if explicit.is_some() {
                    self.send(world, client, Frame::Binary(format!("\x1b[31msession \"{key}\" not found\x1b[0m\r\n").into_bytes()));
                    self.effects.push(Effect::Close { client, code: 1008, reason: "session not found".into() });
                    return Ok(());
                }
                let shell = world.env("SHELL").filter(|s| !s.is_empty()).unwrap_or_else(|| "bash".into());
                self.create_session(world, &key, vec![shell], cols, rows, cwd)?
            }
        };
        self.sessions[id].clients.push(client);
        self.send(world, client, Frame::Text("{\"type\":\"replay-start\"}".into()));
        for chunk in self.sessions[id].buffer.chunks.clone() {
            self.send(world, client, Frame::Binary(chunk));
        }
        self.send(world, client, Frame::Text("{\"type\":\"replay-end\"}".into()));
        if self.sessions[id].exited {
            return Ok(());
        }
        self.clients[client].cap = Some(server::client_cap(cols, rows));
        let message = size_frame(self.sessions[id].cols, self.sessions[id].rows).ok_or("a size whose JavaScript spelling is not reproduced")?;
        self.send(world, client, Frame::Text(message));
        self.apply_resize(world, &key);
        Ok(())
    }

    /// `websocket.message`.
    pub fn ws_message(&mut self, world: &dyn World, client: usize, message: &Frame) -> Result<(), &'static str> {
        let Some(key) = self.clients[client].session_key.clone() else { return Ok(()) };
        let Some(id) = self.live(&key) else { return Ok(()) };
        let pty = self.sessions[id].pty;
        match message {
            Frame::Text(text) => {
                match js::json_parse(text) {
                    Parsed::Unsupported => return Err("JSON that this module does not parse as JSON.parse does"),
                    Parsed::Invalid | Parsed::Value(Json::Null) => {}
                    Parsed::Value(parsed) => {
                        let kind = parsed.get("type");
                        if kind == Some(&Json::String("resize".into())) {
                            let cols = parsed.get("cols").filter(|v| v.truthy());
                            let rows = parsed.get("rows").filter(|v| v.truthy());
                            if let (Some(cols), Some(rows)) = (cols, rows) {
                                let cols = cols.to_number().ok_or("a size that is an array or an object")?;
                                let rows = rows.to_number().ok_or("a size that is an array or an object")?;
                                self.clients[client].cap = Some(server::client_cap(cols, rows));
                                self.apply_resize(world, &key);
                                return Ok(());
                            }
                        }
                        if kind == Some(&Json::String("ping".into())) {
                            let t = match parsed.get("t") {
                                None | Some(Json::Null) => js::json_number(world.now()),
                                Some(Json::Number(x)) => js::json_number(*x),
                                Some(Json::String(s)) => Some(js::json_string(s)),
                                Some(Json::Bool(b)) => Some(b.to_string()),
                                Some(_) => None,
                            }
                            .ok_or("a ping whose t this module does not write as JSON.stringify does")?;
                            self.send(world, client, Frame::Text(format!("{{\"type\":\"pong\",\"t\":{t}}}")));
                            return Ok(());
                        }
                    }
                }
                self.pty_write(pty, text);
            }
            Frame::Binary(bytes) => self.pty_write(pty, &js::text_decode(bytes)),
        }
        Ok(())
    }

    /// `websocket.close`.
    pub fn ws_close(&mut self, world: &dyn World, client: usize) {
        let Some(key) = self.clients[client].session_key.clone() else { return };
        let Some(id) = self.live(&key) else { return };
        self.sessions[id].clients.retain(|c| *c != client);
        self.effects.push(Effect::Stdout(format!("[term] client disconnected from {key} ({} remaining)", self.sessions[id].clients.len())));
        self.apply_resize(world, &key);
    }
}

/// `JSON.stringify({ type: "size", cols, rows })`.
fn size_frame(cols: f64, rows: f64) -> Option<String> {
    Some(format!("{{\"type\":\"size\",\"cols\":{},\"rows\":{}}}", js::json_number(cols)?, js::json_number(rows)?))
}

/// GET /sessions/:key/git from git's three outputs, each trimmed.
fn git_json(branch: &str, porcelain: &str, ab: &str) -> Option<String> {
    let lines: Vec<Vec<u16>> = if porcelain.is_empty() { Vec::new() } else { porcelain.split('\n').filter(|l| !l.is_empty()).map(|l| l.encode_utf16().collect()).collect() };
    // l[0] and l[1] are UTF-16 code units.
    let unit = |l: &Vec<u16>, i: usize| l.get(i).copied();
    let (space, question) = (Some(b' ' as u16), Some(b'?' as u16));
    let staged = lines.iter().filter(|l| unit(l, 0) != space && unit(l, 0) != question).count();
    let unstaged = lines.iter().filter(|l| unit(l, 1) != space && unit(l, 1) != question).count();
    let untracked = lines.iter().filter(|l| l.starts_with(&[b'?' as u16, b'?' as u16])).count();
    let (mut ahead, mut behind) = (0.0, 0.0);
    if !ab.is_empty() {
        let mut parts = ab.split('\t');
        let b = js::string_to_number(parts.next().unwrap_or(""))?;
        let a = match parts.next() {
            Some(text) => js::string_to_number(text)?,
            None => f64::NAN,
        };
        ahead = if a.is_nan() { 0.0 } else { a };
        behind = if b.is_nan() { 0.0 } else { b };
    }
    Some(format!(
        "{{\"branch\":{},\"staged\":{staged},\"unstaged\":{unstaged},\"untracked\":{untracked},\"ahead\":{},\"behind\":{}}}",
        js::json_string(branch),
        js::json_number(ahead)?,
        js::json_number(behind)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::term_summary;
    use crate::testdata::{self, bytes, list, text};
    use serde_json::{json, Value};
    use std::collections::{BTreeMap, HashMap, HashSet};

    /// The stand-ins of rs/parity/record.ts.
    struct TestWorld {
        now: f64,
        env: BTreeMap<String, String>,
        cwd: String,
        existing: HashSet<String>,
        sends: HashMap<usize, f64>,
    }

    impl World for TestWorld {
        fn now(&self) -> f64 {
            self.now
        }
        fn env(&self, name: &str) -> Option<String> {
            self.env.get(name).cloned()
        }
        fn env_list(&self) -> Vec<(String, String)> {
            self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        }
        fn cwd(&self) -> String {
            self.cwd.clone()
        }
        fn exists(&self, path: &str) -> bool {
            self.existing.contains(path)
        }
        fn spawn_succeeds(&self, cmdline: &str, cols: f64, rows: f64) -> bool {
            !cmdline.contains("no-such") && cols.is_finite() && rows.is_finite()
        }
        fn git(&self, _cwd: &str, args: &str) -> String {
            match args {
                "branch --show-current" => "main\n",
                "status --porcelain" => " M a\nM  b\n?? c\nR  d -> e\n",
                _ => "1\t2\n",
            }
            .into()
        }
        fn send_result(&self, client: usize) -> f64 {
            *self.sends.get(&client).unwrap_or(&1.0)
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// An effect as the recorder writes it.
    fn shown(effect: &Effect) -> Value {
        let n = testdata::shown;
        match effect {
            Effect::Stdout(t) => json!(["stdout", t]),
            Effect::Stderr(t) => json!(["stderr", t]),
            Effect::Mkdir(p) => json!(["mkdir", p]),
            Effect::Spawn { pty, cmdline, cwd, cols, rows, env } => json!(["spawn", pty, cmdline, cwd, n(*cols), n(*rows), env.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()]),
            Effect::SpawnFailed { cmdline } => json!(["spawn-failed", cmdline]),
            Effect::PtyWrite { pty, bytes } => json!(["pty-write", pty, hex(bytes)]),
            Effect::PtyResize { pty, cols, rows } => json!(["pty-resize", pty, n(*cols), n(*rows)]),
            Effect::PtyKill { pty } => json!(["pty-kill", pty]),
            Effect::Git { args, cwd } => json!(["git", args, cwd]),
            Effect::Send { client, frame: Frame::Text(t) } => json!(["send", client, "text", t]),
            Effect::Send { client, frame: Frame::Binary(b) } => json!(["send", client, "binary", hex(b)]),
            Effect::Close { client, code, reason } => json!(["close", client, code, reason]),
        }
    }

    /// The effects of the last event, as the recorder writes them; the
    /// directories it made exist from now on, as they do for the recorder.
    fn take(server: &mut Server, world: &mut TestWorld) -> Value {
        let effects: Vec<Effect> = std::mem::take(&mut server.effects);
        for effect in &effects {
            if let Effect::Mkdir(path) = effect {
                world.existing.insert(path.clone());
            }
        }
        Value::Array(effects.iter().map(shown).collect())
    }

    /// What the recorded response says, against what the Rust answered.
    fn same_response(outcome: &Outcome, recorded: &Value) -> Result<(), String> {
        let (status, content_type, body) = match outcome {
            Outcome::Response { status, content_type, body } => (*status, *content_type, body.clone()),
            Outcome::Render { data, tail, offset, .. } => (200, "text/plain; charset=utf-8", server::render_fallback(data, *tail, *offset).into_bytes()),
            Outcome::Summary { data, session_key, last_activity, .. } => {
                let summary = term_summary::summarize(&server::render_fallback(data, 1, 0)).map_err(|_| "declined".to_string())?;
                let fields = summary.json_fields().ok_or("declined")?;
                let body = format!("{{{fields},\"sessionKey\":{},\"lastActivity\":{}}}", js::json_string(session_key), js::json_number(*last_activity).unwrap());
                (200, "application/json;charset=utf-8", body.into_bytes())
            }
            other => return Err(format!("answered {other:?}")),
        };
        // A Response of a string gets its Content-Type from Bun.serve.
        let recorded_type = recorded["type"].as_str().unwrap_or("text/plain;charset=utf-8");
        if recorded["status"].as_u64() != Some(status as u64) || recorded_type != content_type || bytes(&recorded["body"]) != body {
            return Err(format!("answered {status} {content_type} {:?}", String::from_utf8_lossy(&body)));
        }
        Ok(())
    }

    #[test]
    fn the_handlers_do_what_the_typescripts_do() {
        let data = testdata::scenarios();
        let (mut events, mut declined, mut reached_end) = (0, 0, 0);
        for (n, scenario) in list(&data, "scenarios").iter().enumerate() {
            let config = Config {
                access_key: text(&scenario["config"]["accessKey"]).into(),
                repo_base: text(&scenario["config"]["repoBase"]).into(),
                hostname: "parity-host".into(),
                zdotdir: "<ZDOTDIR>".into(),
            };
            assert_eq!(scenario["startUp"], json!([["stdout", "Terminal WS server listening on port 3004"]]));
            assert_eq!(server::listening_line(None).unwrap(), "Terminal WS server listening on port 3004");
            let mut server = Server::new(config);
            let env = scenario["start"]["env"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), text(v).to_string())).collect();
            let mut world = TestWorld {
                now: 1_700_000_000_000.0,
                env,
                cwd: text(&scenario["start"]["cwd"]).into(),
                existing: ["/", "/srv", "/r", "/r/o/p"].iter().map(|s| s.to_string()).collect(),
                sends: HashMap::new(),
            };
            let mut complete = true;
            for (e, event) in list(scenario, "events").iter().enumerate() {
                events += 1;
                let at = format!("scenario {n} event {e}: {event}");
                let recorded = &event["effects"];
                let result: Result<(), &str> = if let Some(http) = event.get("http") {
                    let req = Request {
                        method: text(&http["method"]).into(),
                        pathname: text(&http["pathname"]).into(),
                        search: text(&http["search"]).into(),
                        authorization: http["authorization"].as_str().map(str::to_string),
                        websocket: http["websocket"].as_bool().unwrap(),
                        body: if http["body"].is_null() { Vec::new() } else { bytes(&http["body"]) },
                        ip: text(&http["ip"]).into(),
                    };
                    let outcome = server.fetch(&world, &req);
                    let expected = &event["outcome"];
                    match &outcome {
                        Outcome::Unported(_) => Err("declined"),
                        _ if expected.get("throws").is_some() => panic!("{at}: the TypeScript throws, the Rust answered {outcome:?}"),
                        Outcome::Upgrade { client } => {
                            assert_eq!(expected["upgrade"].as_u64(), Some(*client as u64), "{at}");
                            let effects = take(&mut server, &mut world);
                            assert_eq!(&effects, &expected["fetchEffects"], "{at}");
                            match server.ws_open(&world, *client) {
                                Err(_) => Err("declined"),
                                Ok(()) if expected.get("openThrows").is_some() => panic!("{at}: open throws in the TypeScript"),
                                Ok(()) => Ok(()),
                            }
                        }
                        _ => {
                            if let Err(why) = same_response(&outcome, expected) {
                                panic!("{at}: {why}");
                            }
                            Ok(())
                        }
                    }
                } else if let Some(message) = event.get("message") {
                    let client = message["client"].as_u64().unwrap() as usize;
                    let frame = match message.get("text") {
                        Some(t) => Frame::Text(text(t).into()),
                        None => Frame::Binary(bytes(&message["hex"])),
                    };
                    match server.ws_message(&world, client, &frame) {
                        Err(_) => Err("declined"),
                        Ok(()) if event.get("throws").is_some() => panic!("{at}: the TypeScript throws"),
                        Ok(()) => Ok(()),
                    }
                } else if let Some(client) = event.get("close") {
                    server.ws_close(&world, client.as_u64().unwrap() as usize);
                    Ok(())
                } else if let Some(output) = event.get("data") {
                    server.pty_data(&world, output["pty"].as_u64().unwrap() as usize, &bytes(&output["hex"]))
                } else if let Some(pty) = event.get("exit") {
                    server.pty_exit(&world, pty.as_u64().unwrap() as usize)
                } else if let Some(ms) = event.get("advance") {
                    world.now += ms.as_f64().unwrap();
                    server.advance(&world);
                    Ok(())
                } else if let Some(send) = event.get("sendResult") {
                    world.sends.insert(send["client"].as_u64().unwrap() as usize, send["value"].as_f64().unwrap());
                    Ok(())
                } else if let Some(change) = event.get("env") {
                    let name = text(&change["name"]).to_string();
                    match change["value"].as_str() {
                        Some(value) => world.env.insert(name, value.into()),
                        None => world.env.remove(&name),
                    };
                    Ok(())
                } else {
                    panic!("{at}: an event this test does not know");
                };
                if result.is_err() {
                    // The Rust declines; what the TypeScript did from here on is not compared.
                    declined += 1;
                    complete = false;
                    break;
                }
                assert_eq!(&take(&mut server, &mut world), recorded, "{at}");
            }
            reached_end += complete as usize;
        }
        let scenarios = list(&data, "scenarios").len();
        eprintln!("{events} events of {scenarios} scenarios: {declined} declined, {reached_end} scenarios compared to the end");
        assert!(reached_end * 2 > scenarios, "only {reached_end} of {scenarios} scenarios reached their end");
    }
}
