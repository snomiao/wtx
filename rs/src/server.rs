//! src/server.ts, piece by piece: what the server computes, without the
//! listening, the PTYs and the processes, which stay in the JavaScript (see
//! the crate's documentation).
//!
//! Each function names the TypeScript it stands for, and is tested against
//! that TypeScript run by bun (rs/parity/record.ts, rs/src/testdata).

use crate::js;
use sha2::{Digest, Sha256};

/// `MIN_COLS`, `MIN_ROWS`.
pub const MIN_COLS: f64 = 10.0;
pub const MIN_ROWS: f64 = 2.0;
/// `MAX_BUFFER_BYTES`: the replay buffer, 1 MiB.
pub const MAX_BUFFER_BYTES: usize = 1024 * 1024;

/// The directory under the temp directory that holds the zsh start-up
/// files (`KOHO_ZDOTDIR`), and the files, as `server.ts` writes them when it
/// is loaded, before anything listens.
pub const ZDOTDIR_NAME: &str = "koho-term-zshrc";
pub const ZSH_FILES: [(&str, &str); 3] = [
    (".zshenv", "[[ -f \"$HOME/.zshenv\" ]] && source \"$HOME/.zshenv\"\n"),
    (".zprofile", "[[ -f \"$HOME/.zprofile\" ]] && source \"$HOME/.zprofile\"\n"),
    (
        ".zshrc",
        "[[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\n_koho_report_cwd() { printf '\\033]7;file://%s%s\\007' \"${HOST:-localhost}\" \"$PWD\"; }\nprecmd_functions+=(_koho_report_cwd)\n",
    ),
];

/// The start-up line, `Terminal WS server listening on port ${PORT}`, with
/// PORT as `parseInt(process.env.TERMINAL_WS_PORT ?? "3004")` gives it (not
/// the port Bun.serve took: 0 stays 0). `None` where parseInt is not
/// reproduced exactly (crate::js::parse_int).
pub fn listening_line(port_variable: Option<&str>) -> Option<String> {
    let port = js::parse_int(port_variable.unwrap_or("3004"))?;
    Some(format!("Terminal WS server listening on port {}", js::number_to_string(port)?))
}

/// `sessionName(cwd)`: `s_` and the first 12 hex digits of sha256(cwd).
pub fn session_name(cwd: &str) -> String {
    let digest = Sha256::digest(cwd.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("s_{}", &hex[..12])
}

/// `validateCwd(raw)` for a string or nothing: the directory to use, and
/// whether it has to be made first (`exists` answers existsSync); or the
/// message of the Error it throws.
pub fn validate_cwd(raw: Option<&str>, exists: impl Fn(&str) -> bool) -> Result<(String, bool), String> {
    let raw = match raw {
        None | Some("") => return Err("cwd is required".into()),
        Some(raw) => raw,
    };
    let resolved = raw.replace('\\', "/");
    let bytes = resolved.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/';
    if !(resolved.starts_with('/') || drive) || resolved.contains("/../") {
        return Err(format!("invalid cwd: {raw}"));
    }
    let make = !exists(&resolved);
    Ok((resolved, make))
}

/// A terminal size, in JavaScript numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TermSize {
    pub cols: f64,
    pub rows: f64,
}

/// `negotiateSize(caps, current)`: the smallest cols and the smallest rows
/// over the caps whose two numbers are finite, floored and at least 10 x 2;
/// `current` when there is none.
pub fn negotiate_size(caps: &[TermSize], current: TermSize) -> TermSize {
    let mut cols = f64::INFINITY;
    let mut rows = f64::INFINITY;
    for cap in caps {
        if !cap.cols.is_finite() || !cap.rows.is_finite() {
            continue;
        }
        cols = js_min(cols, cap.cols);
        rows = js_min(rows, cap.rows);
    }
    if !cols.is_finite() || !rows.is_finite() {
        return current;
    }
    TermSize { cols: js_max(MIN_COLS, cols.floor()), rows: js_max(MIN_ROWS, rows.floor()) }
}

/// `setClientCap(ws, cols, rows)`: a client's own size, at least 10 x 2
/// (NaN stays NaN, as Math.max leaves it).
pub fn client_cap(cols: f64, rows: f64) -> TermSize {
    TermSize { cols: js_max(MIN_COLS, cols), rows: js_max(MIN_ROWS, rows) }
}

/// `Math.min(a, b)`: NaN if either is, and -0 below 0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() {
            a
        } else {
            b
        }
    } else {
        a.min(b)
    }
}

/// `Math.max(a, b)`: NaN if either is, and 0 above -0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() {
            a
        } else {
            b
        }
    } else {
        a.max(b)
    }
}

/// A session's replay buffer: the PTY's output chunks as they came
/// (`bufferPush`). The oldest chunk goes while there are more than
/// MAX_BUFFER_BYTES and more than one chunk.
#[derive(Debug, Default, Clone)]
pub struct ReplayBuffer {
    pub chunks: std::collections::VecDeque<Vec<u8>>,
    pub bytes: usize,
}

impl ReplayBuffer {
    pub fn push(&mut self, chunk: Vec<u8>) {
        self.bytes += chunk.len();
        self.chunks.push_back(chunk);
        while self.bytes > MAX_BUFFER_BYTES && self.chunks.len() > 1 {
            if let Some(first) = self.chunks.pop_front() {
                self.bytes -= first.len();
            }
        }
    }

    /// The chunks joined, as `/sessions/:key/buffer` and `/summary` take them.
    pub fn merged(&self) -> Vec<u8> {
        self.chunks.iter().flatten().copied().collect()
    }
}

/// `extractOsc7Cwd(data)`: the directory of the first complete OSC 7
/// sequence (`ESC ]7;file://<host><path>` ended by BEL or ESC \) in the
/// chunk, percent-decoded where it can be.
pub fn osc7_cwd(data: &[u8]) -> Option<String> {
    if !data.contains(&0x1b) {
        return None;
    }
    let text = js::text_decode(data);
    if !text.contains("\x1b]7;") {
        return None;
    }
    // /\x1b\]7;file:\/\/[^/]*(\/.+?)(?:\x07|\x1b\\)/: from each start in
    // turn, up to the first slash, then a slash, at least one character
    // that is not a line terminator, and the shortest run up to BEL or ESC \.
    const START: &str = "\x1b]7;file://";
    for (at, _) in text.match_indices(START) {
        let rest = &text[at + START.len()..];
        let Some(slash) = rest.find('/') else { continue };
        let path = &rest[slash..];
        let mut found = None;
        for (i, c) in path.char_indices().skip(1) {
            if i > 1 && (path[i..].starts_with('\x07') || path[i..].starts_with("\x1b\\")) {
                found = Some(i);
                break;
            }
            if js::is_line_terminator(c) {
                break;
            }
        }
        if let Some(end) = found {
            let raw = &path[..end];
            return Some(js::decode_uri_component(raw).unwrap_or_else(|| raw.to_string()));
        }
    }
    None
}

/// What a chunk of PTY output asks of the terminal, and the server answers
/// itself, in this order: device attributes (`ESC[c`, `ESC[0c`) with
/// `ESC[?1;2c`, the cursor position (`ESC[6n`) with `ESC[1;1R`. Once per
/// chunk each, looked for in the chunk alone.
pub fn query_replies(data: &[u8]) -> Vec<&'static str> {
    let text = js::text_decode(data);
    let mut replies = Vec::new();
    if text.contains("\x1b[c") || text.contains("\x1b[0c") {
        replies.push("\x1b[?1;2c");
    }
    if text.contains("\x1b[6n") {
        replies.push("\x1b[1;1R");
    }
    replies
}

/// `ALLOW_ENV_NAMES` and `ALLOW_ENV_PREFIXES`.
pub const ALLOW_ENV_NAMES: &[&str] = &[
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM", "TMPDIR", "TMP", "TEMP", "HOSTNAME", "HOSTTYPE",
    "MACHTYPE", "OSTYPE", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESS", "MORE",
    "KUBECONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "GITHUB_OWNER", "GH_TOKEN", "GITHUB_TOKEN", "ZDOTDIR", "VSCODE_IPC_HOOK_CLI", "VSCODE_GIT_ASKPASS_NODE",
    "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_IPC_HANDLE", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "HOMEDRIVE", "HOMEPATH", "SystemRoot", "SystemDrive", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ComSpec", "OS", "PATHEXT", "WINDIR",
    "COMPUTERNAME", "USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "CODEHOST", "CODEHOST_ROOT",
];
pub const ALLOW_ENV_PREFIXES: &[&str] = &["LC_", "XDG_", "NODE_", "npm_", "NPM_", "BUN_", "PNPM_", "YARN_", "GIT_", "VSCODE_", "TERMINFO", "SSH_"];

/// The environment `spawnPty` hands bun-pty: the allowed variables of
/// `env` (`scrubSecrets`), then TERM, COLORTERM, LANG, LC_ALL, HOST,
/// HOSTNAME, ZDOTDIR and PROMPT_COMMAND, sorted by name.
///
/// This is what the TypeScript means a session to get. What a session gets
/// with bun-pty 0.4.8 is more: its native side starts the program with the
/// server's real environment, the one the server was started with, and adds
/// these on top, so every variable of that reaches it (rs/parity.json, the
/// `env:` cases). What bun read from .env files is not in it: bun keeps that
/// in `process.env`, so of it only the allowed names reach a session. A Rust
/// server must not copy the leak, and cannot differ from it either: it would
/// have to hand back a server whose environment holds anything outside this
/// list.
pub fn pty_env(env: &[(String, String)], hostname: &str, zdotdir: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut set = |name: &str, value: String| {
        if let Some(entry) = out.iter_mut().find(|(n, _)| n == name) {
            entry.1 = value;
        } else {
            out.push((name.to_string(), value));
        }
    };
    for (name, value) in env {
        if ALLOW_ENV_NAMES.contains(&name.as_str()) || ALLOW_ENV_PREFIXES.iter().any(|p| name.starts_with(p)) {
            set(name, value.clone());
        }
    }
    let prompt = env.iter().rev().find(|(n, _)| n == "PROMPT_COMMAND").map(|(_, v)| v.as_str()).filter(|v| !v.is_empty());
    set("TERM", "xterm-256color".into());
    set("COLORTERM", "truecolor".into());
    set("LANG", "C.UTF-8".into());
    set("LC_ALL", "C.UTF-8".into());
    set("HOST", hostname.into());
    set("HOSTNAME", hostname.into());
    set("ZDOTDIR", zdotdir.into());
    set("PROMPT_COMMAND", format!("printf '\\033]7;file://%s%s\\007' \"$HOSTNAME\" \"$PWD\"{}", prompt.map(|p| format!("; {p}")).unwrap_or_default()));
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// bun-pty's `shQuote`: the command line its native side splits again.
pub fn sh_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".into();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The line `spawnPty` logs: `[term] spawning: bun-pty → <cmd0>  (<cols>x<rows>) in <cwd>`
/// (its `args` are always empty, hence the two spaces).
pub fn spawn_line(cmd: &[String], cols: f64, rows: f64, cwd: &str) -> Option<String> {
    Some(format!("[term] spawning: bun-pty → {}  ({}x{}) in {cwd}", cmd.first()?, js::number_to_string(cols)?, js::number_to_string(rows)?))
}

/// A session as `/status/:owner/:repo` and `/summary` look at it.
#[derive(Debug, Clone)]
pub struct SessionView<'a> {
    pub cwd: &'a str,
    pub last_activity: f64,
}

/// `getTerminalStatusForRepo(repoFolder)` as JSON: the first session whose
/// directory starts with the folder (as text: `/r/o/pp` starts with
/// `/r/o/p`) is active when it printed within the last 60 seconds.
pub fn status_for_repo(sessions: &[SessionView], repo_folder: &str, now: f64) -> Option<String> {
    for session in sessions {
        if !session.cwd.starts_with(repo_folder) {
            continue;
        }
        let age = now - session.last_activity;
        return Some(format!(
            "{{\"status\":\"{}\",\"lastActivity\":{},\"cwd\":{}}}",
            if age < 60_000.0 { "active" } else { "idle" },
            js::json_number(session.last_activity)?,
            js::json_string(session.cwd)
        ));
    }
    Some("{\"status\":\"closed\",\"lastActivity\":null,\"cwd\":null}".into())
}

/// Which session `getTermSummaryForCwd(cwd)` summarises: the first whose
/// directory is `cwd` or lies below `cwd + "/"`.
pub fn summary_session(sessions: &[SessionView], cwd: &str) -> Option<usize> {
    let below = format!("{cwd}/");
    sessions.iter().position(|s| s.cwd == cwd || s.cwd.starts_with(&below))
}

/// `renderTerminalBuffer` when @xterm/headless cannot be loaded: escape
/// sequences and control characters taken out of the decoded text, then the
/// lines [end - tail, end) with end = lines - offset (all of them for 0).
/// `tail` and `offset` are what `Math.max(0, parseInt(...))` gives: whole
/// numbers, 0 or more.
pub fn render_fallback(data: &[u8], tail: usize, offset: usize) -> String {
    let text = js::text_decode(data);
    let stripped = strip_controls(&strip_escapes(&text));
    let lines: Vec<&str> = stripped.split('\n').collect();
    let end = if offset > 0 { lines.len().saturating_sub(offset) } else { lines.len() };
    let start = if tail > 0 { end.saturating_sub(tail) } else { 0 };
    lines[start..end].join("\n")
}

/// `text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, "")`.
fn strip_escapes(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut kept = 0;
    while i < b.len() {
        if b[i] != 0x1b {
            i += 1;
            continue;
        }
        if let Some(end) = escape_at(b, i) {
            out.push_str(&text[kept..i]);
            kept = end;
            i = end;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[kept..]);
    out
}

/// The end of the escape sequence that the expression matches at `i`, its
/// three alternatives tried in order.
fn escape_at(b: &[u8], i: usize) -> Option<usize> {
    let next = *b.get(i + 1)?;
    if next == b'[' {
        let mut j = i + 2;
        while j < b.len() && (0x30..=0x3f).contains(&b[j]) {
            j += 1;
        }
        while j < b.len() && (0x20..=0x2f).contains(&b[j]) {
            j += 1;
        }
        if j < b.len() && (0x40..=0x7e).contains(&b[j]) {
            return Some(j + 1);
        }
    }
    if next == b']' {
        let mut j = i + 2;
        while j < b.len() && b[j] != 0x07 && b[j] != 0x1b {
            j += 1;
        }
        if j < b.len() && b[j] == 0x07 {
            return Some(j + 1);
        }
        if j + 1 < b.len() && b[j] == 0x1b && b[j + 1] == b'\\' {
            return Some(j + 2);
        }
    }
    if (0x40..=0x5a).contains(&next) || (0x5c..=0x5f).contains(&next) {
        return Some(i + 2);
    }
    None
}

/// `text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")`.
fn strip_controls(text: &str) -> String {
    text.chars().filter(|c| !matches!(*c as u32, 0x00..=0x08 | 0x0b | 0x0c | 0x0e..=0x1f | 0x7f)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdata::{self, bytes, double, list, shown, text};
    use serde_json::Value;

    #[test]
    fn session_names_are_the_typescripts() {
        let data = testdata::server();
        for case in list(&data, "sessionName") {
            assert_eq!(session_name(text(&case[0])), text(&case[1]));
        }
    }

    #[test]
    fn working_directories_are_checked_as_the_typescript_checks_them() {
        let data = testdata::server();
        let existing = ["/", "/tmp", "C:/", "/home/u"];
        for case in list(&data, "validateCwd") {
            let raw = match &case[0] {
                Value::String(s) => Some(s.as_str()),
                Value::Null | Value::Bool(false) => None,
                Value::Number(n) if n.as_f64() == Some(0.0) => None,
                other => panic!("an input this test does not know: {other}"),
            };
            let outcome = &case[1];
            let recorded: Vec<String> = outcome["effects"].as_array().unwrap().iter().map(|e| e.to_string()).collect();
            match validate_cwd(raw, |p| existing.contains(&p)) {
                Ok((resolved, make)) => {
                    assert_eq!(Some(resolved.as_str()), outcome["ok"].as_str(), "validateCwd({})", case[0]);
                    let expected: Vec<String> = if make { vec![format!("[\"mkdir\",{}]", js::json_string(&resolved))] } else { vec![] };
                    assert_eq!(recorded, expected, "validateCwd({})", case[0]);
                }
                Err(message) => {
                    assert_eq!(Some(message.as_str()), outcome["error"].as_str(), "validateCwd({})", case[0]);
                    assert!(recorded.is_empty());
                }
            }
        }
    }

    #[test]
    fn sizes_are_negotiated_as_the_typescript_does() {
        let data = testdata::server();
        for case in list(&data, "negotiateSize") {
            let size = |pair: &Value| TermSize { cols: double(&pair[0]), rows: double(&pair[1]) };
            let caps: Vec<TermSize> = case[0].as_array().unwrap().iter().map(size).collect();
            let next = negotiate_size(&caps, size(&case[1]));
            assert_eq!([shown(next.cols), shown(next.rows)], [text(&case[2][0]), text(&case[2][1])], "{case}");
        }
    }

    #[test]
    fn osc7_is_found_as_the_typescript_finds_it() {
        let data = testdata::server();
        for case in list(&data, "extractOsc7Cwd") {
            assert_eq!(osc7_cwd(&bytes(&case[0])).as_deref(), case[1].as_str(), "extractOsc7Cwd({})", text(&case[0]));
        }
    }

    #[test]
    fn the_pty_gets_the_environment_the_typescript_builds() {
        let data = testdata::server();
        for case in list(&data, "ptyEnv") {
            let env: Vec<(String, String)> = case[0].as_array().unwrap().iter().map(|p| (text(&p[0]).to_string(), text(&p[1]).to_string())).collect();
            let cmd: Vec<String> = case[1].as_array().unwrap().iter().map(|v| text(v).to_string()).collect();
            let effects = case[2].as_array().unwrap();
            // [stdout, line], [spawn, id, cmdline, cwd, cols, rows, pairs], [pty-kill, id]
            assert_eq!(effects.len(), 3, "{case}");
            let spawn = &effects[1];
            let (cwd, cols, rows) = (text(&spawn[3]), text(&spawn[4]).parse::<f64>().unwrap(), text(&spawn[5]).parse::<f64>().unwrap());
            assert_eq!(spawn_line(&cmd, cols, rows, cwd).as_deref(), effects[0][1].as_str(), "{case}");
            let line: Vec<String> = cmd.iter().map(|c| sh_quote(c)).collect();
            assert_eq!(line.join(" "), text(&spawn[2]));
            let pairs: Vec<(String, String)> = spawn[6].as_array().unwrap().iter().map(|p| (text(&p[0]).to_string(), text(&p[1]).to_string())).collect();
            assert_eq!(pty_env(&env, "parity-host", "<ZDOTDIR>"), pairs, "{case}");
        }
    }

    #[test]
    fn the_replay_buffer_keeps_what_the_typescripts_keeps() {
        let data = testdata::server();
        for case in list(&data, "bufferPush") {
            let mut buffer = ReplayBuffer::default();
            for (size, after) in case[0].as_array().unwrap().iter().zip(case[1].as_array().unwrap()) {
                buffer.push(vec![0; size.as_u64().unwrap() as usize]);
                assert_eq!(buffer.bytes as u64, after[0].as_u64().unwrap());
                let lengths: Vec<u64> = buffer.chunks.iter().map(|c| c.len() as u64).collect();
                let expected: Vec<u64> = after[1].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).collect();
                assert_eq!(lengths, expected);
            }
        }
    }

    #[test]
    fn status_and_summary_pick_the_sessions_the_typescript_picks() {
        let data = testdata::server();
        for case in list(&data, "statusForRepo") {
            let cwds: Vec<(String, f64)> = case[0].as_array().unwrap().iter().map(|s| (text(&s[0]).to_string(), s[1].as_f64().unwrap())).collect();
            let views: Vec<SessionView> = cwds.iter().map(|(cwd, at)| SessionView { cwd, last_activity: *at }).collect();
            let now = case[1].as_f64().unwrap();
            assert_eq!(status_for_repo(&views, text(&case[2]), now).as_deref(), case[3].as_str(), "{case}");
        }
        for case in list(&data, "summarySession") {
            let cwds: Vec<&str> = case[0].as_array().unwrap().iter().map(text).collect();
            let views: Vec<SessionView> = cwds.iter().map(|cwd| SessionView { cwd, last_activity: 0.0 }).collect();
            let key = summary_session(&views, text(&case[1])).map(|i| format!("k{i}"));
            assert_eq!(key.as_deref(), case[2].as_str(), "{case}");
        }
    }

    #[test]
    fn the_fallback_renderer_is_the_typescripts() {
        let data = testdata::server();
        for case in list(&data, "renderFallback") {
            let tail = case[1].as_u64().unwrap() as usize;
            let offset = case[2].as_u64().unwrap() as usize;
            assert_eq!(render_fallback(&bytes(&case[0]), tail, offset), text(&case[3]), "{case}");
        }
    }

    #[test]
    fn the_zsh_files_are_the_typescripts() {
        let data = testdata::server();
        let zshrc = list(&data, "zshrc");
        assert_eq!(text(&zshrc[0]), ZDOTDIR_NAME);
        for ((name, content), recorded) in ZSH_FILES.iter().zip(&zshrc[1..]) {
            assert_eq!((*name, *content), (text(&recorded[0]), text(&recorded[1])));
        }
    }

    #[test]
    fn the_start_up_line_is_the_typescripts() {
        let data = testdata::js();
        for case in list(&data, "parseInt") {
            let Some(line) = listening_line(Some(text(&case[0]))) else { continue };
            let shown = text(&case[1]);
            let shown = if shown == "-0" { "0" } else { shown };
            assert_eq!(line, format!("Terminal WS server listening on port {shown}"));
        }
        assert_eq!(listening_line(None).unwrap(), "Terminal WS server listening on port 3004");
    }

    #[test]
    fn queries_are_answered_as_the_typescript_answers_them() {
        assert_eq!(query_replies(b"\x1b[c"), ["\x1b[?1;2c"]);
        assert_eq!(query_replies(b"x\x1b[0cy\x1b[6n"), ["\x1b[?1;2c", "\x1b[1;1R"]);
        assert!(query_replies(b"\x1b[5n\x1b[1c").is_empty());
    }
}
