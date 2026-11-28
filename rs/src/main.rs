//! wtx — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and a parity test shows it behaves like the
//! TypeScript; until then it is handed back to the JavaScript the package
//! still ships, so nothing changes for users.

mod js_fallback;

/// The package's JavaScript entry, relative to the package root.
const JS_ENTRY: &str = "wtx.mjs";

/// `WTX_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("WTX_NO_NATIVE").is_none()
}

fn main() {
    // wtx is one long-running server and reads no arguments: every command
    // line starts it. Once it listens, a request can no longer be handed
    // back, so the binary can only take an invocation whose every request it
    // would answer exactly as src/server.ts and Bun.serve do. It cannot yet
    // (the screen rendering of @xterm/headless, bun's error pages, a PTY;
    // see rs/src/lib.rs), so the whole invocation goes to wtx.mjs. The parts
    // that are ported live in the library, tested against the TypeScript.
    //
    // Arguments that are not valid UTF-8 are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    if let Some(args) = args.filter(|_| native()) {
        // Ported commands go here, one arm each, once their parity cases pass.
        // Everything the binary answers itself belongs in this match,
        // `--version` included, so that `WTX_NO_NATIVE=1` switches it off.
        //
        // An arm takes only the invocations it implements exactly. For the
        // rest it falls out of the match, before it has printed or changed
        // anything, and the JavaScript answers. `js_fallback::attempt` is the
        // guard for that: the command works out its whole answer first and
        // returns it, or returns `Err(js_fallback::HandBack)`; and should it
        // panic, the invocation is handed back just the same.
        //
        //   Some("status") => {
        //       if let Some(text) = js_fallback::attempt(|| status::answer(&args[1..])) {
        //           // As console.log under bun: a reader that has gone away
        //           // (`| head`) is not an error. Output the TypeScript writes
        //           // with process.stdout.write: see "Printing" in js_fallback.rs.
        //           let _ = std::io::Write::write_all(&mut std::io::stdout(), text.as_bytes());
        //           return;
        //       }
        //   }
        // Until the match has two arms of its own, clippy would rather see no
        // match, or an `if let`.
        #[allow(clippy::match_single_binding, clippy::single_match)]
        match args.first().map(String::as_str) {
            _ => {}
        }
    }
    // A run that rustify's npm launcher started (the first after an install
    // or upgrade, and every run where it cannot link) is handed back like
    // any other. Launcher v3 starts the binary with the environment the
    // command was started with, not with the launcher's process.env, which
    // holds the working directory's .env files: so wtx.mjs's bun loads them
    // itself, as when it is the command, and they stay out of the sessions.
    // A preload of bunfig.toml or BUN_OPTIONS has already run once in the
    // launcher, which nothing here can undo (rs/parity/first-run.mjs).
    js_fallback::run(JS_ENTRY)
}
