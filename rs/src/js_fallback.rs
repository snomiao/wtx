//! rustify JS fallback v5 — copy into the crate as `src/js_fallback.rs`.
//! (wtx's changes, each marked `wtx:` where it is made: wtx.mjs is started
//! as its `#!/usr/bin/env bun` line has the system start it, and never with
//! node, which cannot run it; on Windows bun is looked for as a command
//! prompt looks for it, `bun.cmd` included; and ROOT_ENV is taken out of the
//! JavaScript's environment when it names this package, as the launcher
//! sets it, and only then.)
//! (v2: waits for the JavaScript on Ctrl+C on Windows. v3: starts the
//! JavaScript with the runtime its own `#!` line names, and offers a
//! TypeScript entry to bun only. v4: says so when bun is what is missing.
//! v5: says on stderr that it handed back when `RUSTIFY_HANDBACK_TRACE` is
//! set; `attempt` runs a ported command so that it can decline, and so that a
//! bug in it costs the user nothing.)
//!
//! For the time when the Rust binary is already the command users run but some
//! commands still exist only in the package's JavaScript. The binary handles
//! what it has ported and hands everything else to the old entry point:
//!
//! ```ignore
//! match command {
//!     "send" | "search" => run_natively(),
//!     _ => js_fallback::run("dist/cli.js"), // never returns
//! }
//! ```
//!
//! Ported commands start at native speed; the others behave exactly as before.
//!
//! A ported command seldom implements every invocation. `attempt` is for the
//! usual shape: the command works out its whole answer before it prints or
//! changes anything, and says `Err(HandBack)` for a command line or a state of
//! the machine it does not implement:
//!
//! ```ignore
//! "status" => {
//!     if let Some(text) = js_fallback::attempt(|| status::answer(&args[1..])) {
//!         // A reader that has gone away (`| head`) is not an error.
//!         let _ = std::io::Write::write_all(&mut std::io::stdout(), text.as_bytes());
//!         return;
//!     }
//!     js_fallback::run("dist/cli.js")
//! }
//! ```
//!
//! Who answered can be seen from outside: with `RUSTIFY_HANDBACK_TRACE=1` in
//! the environment, `run` first writes `rustify: handed back to the
//! JavaScript` to stderr, a panic that `attempt` swallowed is reported before
//! that line, and a native answer looks as it always does.
//!
//! Delete this file when nothing falls back any more, and take the `[native]`
//! and `[handback]` markers off the project's smoke lines with it: the install
//! smoke test finds out whether a binary can say who answered by looking for
//! that line's text in it, and fails a marked line when the text is missing.

use std::cell::Cell;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

/// Environment variable the npm launcher sets to the package directory when
/// the binary runs from the platform package. Use the same name as
/// `rustify.rootEnv` in package.json, and make it specific to the project
/// (`MYCLI_PACKAGE_ROOT`) so one tool starting another does not inherit it.
pub const ROOT_ENV: &str = "WTX_PACKAGE_ROOT";

/// Set this variable to any value that is not empty and `run` writes
/// `TRACE_LINE` to stderr before it starts the JavaScript. That shows who
/// answered a command where no parity test runs: rustify's install smoke test
/// sets it for a line marked `[native]` or `[handback]`, and it finds out
/// whether a binary is able to say the line by looking for the text in the
/// file. So the name and the line are the same in every project: do not
/// change them. The JavaScript is started without the variable, so that a
/// tool it starts in turn cannot write the line in this binary's name.
pub const TRACE_ENV: &str = "RUSTIFY_HANDBACK_TRACE";
pub const TRACE_LINE: &str = "rustify: handed back to the JavaScript";

fn tracing() -> bool {
    std::env::var_os(TRACE_ENV).is_some_and(|value| !value.is_empty())
}

/// Directory of the npm package this binary was installed with, if any.
pub fn package_root() -> Option<PathBuf> {
    // Installed and linked: the binary is <package>/rustify/<command>, and the
    // packer puts a package.json marker next to it.
    if let Ok(exe) = std::env::current_exe() {
        // macOS reports the path the command was started through, and for an
        // npm install that is a symlink in the package manager's bin directory.
        #[cfg(unix)]
        let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        if let Some(bin) = exe.parent() {
            if bin.join("package.json").is_file() {
                if let Some(root) = bin.parent() {
                    if root.join("package.json").is_file() {
                        return Some(root.to_path_buf());
                    }
                }
            }
        }
    }
    // Running from the platform package: the launcher told us.
    let root = PathBuf::from(std::env::var_os(ROOT_ENV)?);
    root.join("package.json").is_file().then_some(root)
}

/// Runs the package's JavaScript entry with this process's arguments and ends
/// the process with its exit code. `entry` is relative to the package root.
pub fn run(entry: &str) -> ! {
    if tracing() {
        // A closed stderr must not stop the hand-back.
        let _ = writeln!(std::io::stderr(), "{TRACE_LINE}");
    }
    let Some(root) = package_root() else {
        eprintln!(
            "this command is not available in the standalone binary yet; \
             install the npm package to use it"
        );
        std::process::exit(1);
    };
    let script = root.join(entry);
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    // wtx: one way to start the entry, the one the published package has.
    // Before this binary, `wtx` was wtx.mjs itself, which the system starts
    // through its `#!/usr/bin/env bun` line: so does this, and `env` then
    // looks for bun on PATH and says so, in its own words, when there is
    // none. node is not tried: wtx.mjs imports "./src/server" without an
    // extension, which node cannot resolve.
    let runtime = runtime(&script);
    let mut command = program(&runtime[0]);
    command.args(&runtime[1..]).arg(&script).args(&args).env_remove(TRACE_ENV);
    // wtx: the JavaScript gets the environment it would have had without the
    // binary. The launcher sets ROOT_ENV to this package's directory, and wtx
    // passes its whole environment on to every terminal session, where the
    // variable would show up. A value of the user's own that names another
    // directory stays, as it would for wtx.mjs.
    if names_root(&root) {
        command.env_remove(ROOT_ENV);
    }
    #[cfg(unix)]
    let error = {
        use std::os::unix::process::CommandExt;
        // Replaces this process, so signals and the exit code need no relaying.
        command.exec()
    };
    #[cfg(not(unix))]
    let error = {
        #[cfg(windows)]
        stay_alive_on_ctrl_c();
        match command.status() {
            Ok(status) => std::process::exit(status.code().unwrap_or(1)),
            Err(err) => err,
        }
    };
    let program_name = std::path::Path::new(&runtime[0]).file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if program_name.eq_ignore_ascii_case("bun") {
        eprintln!("cannot run {}: it needs bun, which could not be started ({error}). See https://bun.sh", script.display());
    } else {
        eprintln!("cannot run {}: {} could not be started ({error})", script.display(), runtime.join(" "));
    }
    std::process::exit(127);
}

/// Whether ROOT_ENV holds the directory `root`, as the npm launcher sets it
/// (and as a test that points the binary at a package does). wtx: only then
/// is it the launcher's, to be taken out of the JavaScript's environment.
pub fn names_root(root: &std::path::Path) -> bool {
    let Some(value) = std::env::var_os(ROOT_ENV) else {
        return false;
    };
    let named = PathBuf::from(value);
    if named.as_os_str().is_empty() {
        return false;
    }
    match (std::fs::canonicalize(&named), std::fs::canonicalize(root)) {
        (Ok(a), Ok(b)) => a == b,
        _ => named == root,
    }
}

/// What a ported command returns for an invocation, or a state of the
/// machine, that it does not implement exactly: the JavaScript has to answer.
#[allow(dead_code)] // unused until the first command is ported
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HandBack;

thread_local! {
    /// Set while an attempt runs on this thread.
    static IN_ATTEMPT: Cell<bool> = const { Cell::new(false) };
    /// Set by `commit`, for the attempt running on this thread.
    static COMMITTED: Cell<bool> = const { Cell::new(false) };
}

// Both are asked by the panic hook, which can run while the thread is ending.
fn in_attempt() -> bool {
    IN_ATTEMPT.try_with(Cell::get).unwrap_or(false)
}

fn committed() -> bool {
    COMMITTED.try_with(Cell::get).unwrap_or(true)
}

/// Says that the command is about to print or change something, so the
/// invocation can no longer be handed back. Only a command that prints or
/// writes inside `attempt` needs this (one that reports progress while it
/// works, say); a command that returns its whole answer does not. It applies
/// to the attempt running on the calling thread, and the next attempt starts
/// afresh.
#[allow(dead_code)]
pub fn commit() {
    COMMITTED.with(|flag| flag.set(true));
}

/// Runs a ported command up to its answer. `Some(answer)` is for the caller
/// to print and carry out. `None` means the invocation goes to the
/// JavaScript (call `run` next): the command declined with `Err(HandBack)`,
/// or it panicked.
///
/// A panic is a bug in the port. As long as the command has printed and
/// changed nothing, the JavaScript can still answer in its place, so the
/// panic is swallowed without a word and the user gets what they asked for.
/// With `TRACE_ENV` set, the panic is reported as usual before the hand-back
/// line, which is how to find such a bug.
///
/// After `commit` there is no way back. A panic is then reported and ends the
/// process as any panic does (exit code 101), and returning `Err(HandBack)`
/// is itself a bug and panics.
///
/// The panic hook (what prints "thread 'main' panicked at …") belongs to the
/// whole process. While attempts run, a quieter one is in its place, and the
/// hook that was there before is put back when the last of them returns. In
/// the program, the quiet hook silences a panic on any thread, so a worker
/// thread the command started says nothing either. In the crate's own tests
/// (`cfg(test)`) it silences only the threads that run an attempt, so that a
/// test failing beside them keeps its message; there a worker thread started
/// inside an attempt is reported. Either way, a panic is reported on the
/// thread of an attempt that has committed, and everywhere when the trace is
/// on. Attempts may run on several threads at once and inside one another.
/// A test that puts a panic hook of its own in place should not run beside
/// tests that call `attempt`.
///
/// This relies on unwinding. A crate built with `panic = "abort"` cannot
/// catch anything: there a panic ends the process at once, with its usual
/// message, and the JavaScript is not started. The Cargo.toml that `rustify
/// scaffold` writes leaves the default, which unwinds.
#[allow(dead_code)]
pub fn attempt<T>(command: impl FnOnce() -> Result<T, HandBack>) -> Option<T> {
    use std::panic;
    // An attempt inside another starts afresh as well. When it returns, the
    // outer one is as it was, except that what the inner one committed stays
    // committed: it may have printed.
    let outer = (IN_ATTEMPT.replace(true), COMMITTED.replace(false));
    let outcome = if cfg!(panic = "unwind") {
        quiet_panics(true);
        let outcome = panic::catch_unwind(panic::AssertUnwindSafe(command));
        quiet_panics(false);
        outcome
    } else {
        Ok(command())
    };
    let committed = committed();
    IN_ATTEMPT.set(outer.0);
    COMMITTED.set(outer.1 || committed);
    match outcome {
        Ok(Ok(answer)) => Some(answer),
        Ok(Err(HandBack)) if committed => panic!("a ported command handed back after js_fallback::commit()"),
        Err(payload) if committed => panic::resume_unwind(payload),
        Ok(Err(HandBack)) | Err(_) => None,
    }
}

/// What `std::panic::take_hook` returns (`PanicHookInfo` needs Rust 1.81).
type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

/// How many attempts are running, and the hook that was in place before the
/// first of them.
static QUIET: std::sync::Mutex<(usize, Option<std::sync::Arc<PanicHook>>)> = std::sync::Mutex::new((0, None));

/// Puts the quiet panic hook in place for an attempt (`true`), or takes it
/// away again when the last attempt is over (`false`).
fn quiet_panics(on: bool) {
    use std::panic;
    use std::sync::Arc;
    let mut state = QUIET.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (running, previous) = &mut *state;
    if on {
        if *running == 0 {
            let earlier: Arc<PanicHook> = Arc::new(panic::take_hook());
            let report = Arc::clone(&earlier);
            panic::set_hook(Box::new(move |info| {
                if committed() || tracing() || (cfg!(test) && !in_attempt()) {
                    report(info);
                }
            }));
            *previous = Some(earlier);
        }
        *running += 1;
        return;
    }
    *running -= 1;
    if *running == 0 {
        if let Some(earlier) = previous.take() {
            // Drops the quiet hook, and with it its share of the earlier one.
            drop(panic::take_hook());
            panic::set_hook(match Arc::try_unwrap(earlier) {
                Ok(hook) => hook,
                // The command kept the quiet hook somewhere, and with it a
                // share of the earlier one.
                Err(shared) => Box::new(move |info| shared(info)),
            });
        }
    }
}

/// wtx: the command that runs `script`, before the script's path and the
/// arguments. On Linux and macOS it is what the script's `#!` line names, as
/// the system itself would start the script: for wtx.mjs `/usr/bin/env bun`,
/// so that bun is looked for on PATH by `env`, which reports in its own words
/// and with its own exit code when it is not there (127), as it did when
/// the command was wtx.mjs itself. A script without such a line (the parity
/// runner's stand-in package) is started with bun. On Windows, where nothing
/// reads that line, it is bun, found as the package managers' command shims
/// find it (`bun.exe`, or the `bun.cmd` that `npm i -g bun` writes).
fn runtime(script: &std::path::Path) -> Vec<String> {
    #[cfg(unix)]
    {
        let head = std::fs::read(script).unwrap_or_default();
        if let Some(command) = shebang(&head, cfg!(target_os = "macos")) {
            return command;
        }
        vec!["bun".to_string()]
    }
    #[cfg(windows)]
    {
        let _ = script;
        let path = std::env::var_os("PATH").unwrap_or_default();
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| DEFAULT_PATHEXT.to_string());
        let found = find_program("bun", std::env::split_paths(&path), &pathext, |file| file.is_file());
        vec![found.map_or_else(|| "bun".to_string(), |file| file.to_string_lossy().into_owned())]
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = script;
        vec!["bun".to_string()]
    }
}

/// The interpreter and its arguments that the system takes from a script's
/// first line, `#!<interpreter> <argument>`: on Linux the rest of the line is
/// one argument, on macOS (`split`) it is split at blanks. `None` for a line
/// that is not a `#!` line or names no absolute interpreter, which the system
/// would not start that way.
#[allow(dead_code)] // unused on Windows, which reads no `#!` line
fn shebang(head: &[u8], split: bool) -> Option<Vec<String>> {
    let rest = head.strip_prefix(b"#!")?;
    let line = &rest[..rest.iter().position(|&b| b == b'\n').unwrap_or(rest.len())];
    let line = std::str::from_utf8(line).ok()?;
    let blank = |c: char| c == ' ' || c == '\t';
    let line = line.trim_start_matches(blank);
    let (interpreter, argument) = line.split_once(blank).unwrap_or((line, ""));
    if !interpreter.starts_with('/') {
        return None;
    }
    let mut command = vec![interpreter.to_string()];
    let argument = argument.trim_matches(blank);
    if split {
        command.extend(argument.split(blank).filter(|word| !word.is_empty()).map(String::from));
    } else if !argument.is_empty() {
        command.push(argument.to_string());
    }
    Some(command)
}

/// What Windows takes for PATHEXT when it is not set.
#[allow(dead_code)]
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";

/// The first `<dir>\<name><ext>` that is a file, for the directories of PATH
/// in order and, in each, the extensions of PATHEXT in order, as a command
/// prompt looks for a command (but not in the current directory first).
/// Only the extensions a program can be started from count: `.com`, `.exe`,
/// and the `.bat` and `.cmd` files that Rust starts through cmd.exe, with
/// their arguments quoted for it.
#[allow(dead_code)] // used on Windows, tested everywhere
fn find_program(
    name: &str,
    dirs: impl IntoIterator<Item = PathBuf>,
    pathext: &str,
    is_file: impl Fn(&std::path::Path) -> bool,
) -> Option<PathBuf> {
    let extensions: Vec<&str> = pathext
        .split(';')
        .filter(|ext| [".com", ".exe", ".bat", ".cmd"].iter().any(|known| ext.eq_ignore_ascii_case(known)))
        .collect();
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in &extensions {
            let file = dir.join(format!("{name}{ext}"));
            if is_file(&file) {
                return Some(file);
            }
        }
    }
    None
}

/// A command for `name`. (wtx: there is nothing else to start: bun, or what
/// the `#!` line names.)
fn program(name: &str) -> Command {
    Command::new(name)
}

/// Ctrl+C reaches every process attached to the console. Without a handler
/// this process would end at once and hand the prompt back while the
/// JavaScript is still shutting down. With one it waits, and exits with the
/// child's exit code. A handler, unlike the "ignore Ctrl+C" flag, is not
/// inherited, so the child still gets the key press.
#[cfg(windows)]
fn stay_alive_on_ctrl_c() {
    extern "system" {
        fn SetConsoleCtrlHandler(
            handler: Option<unsafe extern "system" fn(u32) -> i32>,
            add: i32,
        ) -> i32;
    }
    unsafe extern "system" fn handled(_event: u32) -> i32 {
        1
    }
    unsafe {
        SetConsoleCtrlHandler(Some(handled), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// wtx: the `#!` line as Linux (one argument) and macOS (split at blanks)
    /// read it.
    #[test]
    fn the_shebang_is_read_as_the_system_reads_it() {
        let linux = |line: &str| shebang(line.as_bytes(), false);
        let macos = |line: &str| shebang(line.as_bytes(), true);
        // wtx.mjs's own line (with LF, as npm publishes it from Linux; a
        // Windows checkout may have CR LF).
        let wtx = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../wtx.mjs")).unwrap().replace("\r\n", "\n").into_bytes();
        assert_eq!(shebang(&wtx, false).unwrap(), ["/usr/bin/env", "bun"]);
        assert_eq!(shebang(&wtx, true).unwrap(), ["/usr/bin/env", "bun"]);
        assert_eq!(linux("#!/usr/bin/env bun\nimport x").unwrap(), ["/usr/bin/env", "bun"]);
        assert_eq!(linux("#! \t/usr/bin/env  bun \t\n").unwrap(), ["/usr/bin/env", "bun"]);
        assert_eq!(linux("#!/usr/bin/env -S bun --smol\n").unwrap(), ["/usr/bin/env", "-S bun --smol"]);
        assert_eq!(macos("#!/usr/bin/env -S bun --smol\n").unwrap(), ["/usr/bin/env", "-S", "bun", "--smol"]);
        assert_eq!(linux("#!/bin/sh").unwrap(), ["/bin/sh"]);
        // A carriage return is part of the line for the system.
        assert_eq!(linux("#!/usr/bin/env bun\r\n").unwrap(), ["/usr/bin/env", "bun\r"]);
        assert_eq!(linux("#!env bun\n"), None);
        assert_eq!(linux("console.log(1)\n"), None);
        assert_eq!(linux(""), None);
    }

    /// wtx: bun on Windows, as a command prompt finds it.
    #[test]
    fn bun_is_found_as_a_command_prompt_finds_it() {
        let files = ["c:/npm/bun.cmd", "c:/npm/bun.ps1", "c:/npm/bun", "c:/bun/bun.exe", "c:/js/bun.js"];
        // Windows finds a file whatever the letter case of its name.
        let spelt = |file: &std::path::Path| file.to_string_lossy().replace('\\', "/").to_lowercase();
        let is_file = |file: &std::path::Path| files.iter().any(|f| *f == spelt(file));
        let find = |dirs: &[&str], pathext: &str| find_program("bun", dirs.iter().map(PathBuf::from), pathext, is_file).map(|f| spelt(&f));
        // The first directory of PATH that has it, whatever the extension.
        assert_eq!(find(&["C:/npm", "C:/bun"], DEFAULT_PATHEXT).as_deref(), Some("c:/npm/bun.cmd"));
        assert_eq!(find(&["C:/bun", "C:/npm"], DEFAULT_PATHEXT).as_deref(), Some("c:/bun/bun.exe"));
        assert_eq!(find(&["", "C:/none", "C:/bun"], ".exe;.CMD").as_deref(), Some("c:/bun/bun.exe"));
        // Only what a program can be started from: not a .ps1, a sh script or a .js.
        assert_eq!(find(&["C:/js", "C:/npm"], ".JS;.PS1;.CMD").as_deref(), Some("c:/npm/bun.cmd"));
        assert_eq!(find(&["C:/npm"], ".EXE"), None);
        assert_eq!(find(&[], DEFAULT_PATHEXT), None);
    }

    /// Whether the test `test` of this module is to run in this process. The
    /// panic hook belongs to the whole process, and the crate's other tests
    /// may call `attempt`, put a hook in place or panic while a test watches
    /// it. So such a test runs again, alone, in a process of its own, once
    /// with the trace off and once with it on: `alone` returns true there.
    /// Anywhere else it starts those two runs, fails unless the test passed
    /// in both, and returns false.
    fn alone(test: &str) -> bool {
        const ALONE: &str = "RUSTIFY_FALLBACK_TEST_ALONE";
        if std::env::var_os(ALONE).is_some() {
            return true;
        }
        // The test binary names a test by its path without the crate's name.
        let module = module_path!().split_once("::").map_or(module_path!(), |(_, path)| path);
        let name = format!("{module}::{test}");
        for trace in [false, true] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args([name.as_str(), "--exact", "--test-threads=1"]).env(ALONE, "1");
            if trace {
                command.env(TRACE_ENV, "1");
            } else {
                command.env_remove(TRACE_ENV);
            }
            let run = command.output().unwrap();
            let output = format!("{}{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
            assert!(
                run.status.success() && output.contains("1 passed"),
                "{name}, run alone with the trace {}:\n{output}",
                if trace { "on" } else { "off" }
            );
        }
        false
    }

    /// One test for all of `attempt`, in this order.
    #[test]
    fn attempt_answers_declines_and_hands_back_a_panic_until_commit() {
        use std::panic::catch_unwind;
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        if !alone("attempt_answers_declines_and_hands_back_a_panic_until_commit") {
            return;
        }
        // Counts the panics that reach the hook that was there before, on any
        // thread, and passes them on, so that a failing assertion shows.
        static REPORTED: AtomicUsize = AtomicUsize::new(0);
        let reported = || REPORTED.load(SeqCst);
        let before = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            REPORTED.fetch_add(1, SeqCst);
            before(info);
        }));
        // With the trace on, a swallowed panic is reported too.
        let traced = usize::from(tracing());
        let mut expected = 0;
        let bug = || -> Result<i32, HandBack> { panic!("a bug in a ported command") };

        assert_eq!(attempt(|| Ok(7)), Some(7));
        assert_eq!(attempt(|| Err::<i32, _>(HandBack)), None);
        assert_eq!(attempt(bug), None);
        expected += traced;
        assert_eq!(reported(), expected, "a panic before commit is not reported");
        assert!(catch_unwind(|| panic!("outside attempt")).is_err());
        expected += 1;
        assert_eq!(reported(), expected, "the hook that was there before is back");

        // Attempts on several threads at once leave that hook in place too.
        let threads: Vec<_> = (0..4)
            .map(|_| std::thread::spawn(move || (0..50).filter(|_| attempt(bug).is_none()).count()))
            .collect();
        assert!(threads.into_iter().all(|thread| thread.join().unwrap() == 50));
        expected += 200 * traced;
        assert!(catch_unwind(|| panic!("after the threads")).is_err());
        expected += 1;
        assert_eq!(reported(), expected, "the hook is back after attempts on several threads");

        // In a test build, a panic on a thread that runs no attempt is
        // reported while another thread runs one.
        let (started, running) = std::sync::mpsc::channel();
        let (finish, finished) = std::sync::mpsc::channel::<()>();
        let beside = std::thread::spawn(move || {
            attempt(|| {
                started.send(()).unwrap();
                finished.recv().unwrap();
                Ok(())
            })
        });
        running.recv().unwrap();
        assert!(catch_unwind(|| panic!("a test failing beside an attempt")).is_err());
        expected += 1;
        assert_eq!(reported(), expected, "a panic beside an attempt is reported");
        finish.send(()).unwrap();
        assert_eq!(beside.join().unwrap(), Some(()));

        let late = || -> Result<i32, HandBack> {
            commit();
            panic!("a bug after the first output")
        };
        assert!(catch_unwind(|| attempt(late)).is_err(), "a panic after commit is not swallowed");
        expected += 1;
        assert_eq!(reported(), expected, "and it is reported");
        let late_hand_back = || -> Result<i32, HandBack> {
            commit();
            Err(HandBack)
        };
        assert!(catch_unwind(|| attempt(late_hand_back)).is_err(), "handing back after commit is a bug");
        expected += 1;
        assert_eq!(reported(), expected);
        assert_eq!(attempt(|| Err::<i32, _>(HandBack)), None, "the next attempt starts afresh");

        // Attempts inside one another.
        let outer = || -> Result<i32, HandBack> {
            assert_eq!(attempt(|| Err::<i32, _>(HandBack)), None);
            Ok(1)
        };
        assert_eq!(attempt(outer), Some(1), "an inner attempt that declines leaves the outer one going");
        let outer_bug = || -> Result<i32, HandBack> {
            assert_eq!(attempt(|| Ok(2)), Some(2));
            panic!("a bug after an inner attempt")
        };
        assert_eq!(attempt(outer_bug), None);
        expected += traced;
        assert_eq!(reported(), expected, "after an inner attempt, the outer one is still quiet");
        let inner_commit = || -> Result<i32, HandBack> {
            commit();
            Ok(3)
        };
        let outer_after_commit = || -> Result<i32, HandBack> {
            assert_eq!(attempt(inner_commit), Some(3));
            Err(HandBack)
        };
        assert!(catch_unwind(|| attempt(outer_after_commit)).is_err(), "what an inner attempt committed stays committed");
        expected += 1;
        assert_eq!(reported(), expected);
    }

    /// wtx: one way to start the entry, never node.
    #[cfg(unix)]
    #[test]
    fn the_entry_is_started_as_its_first_line_says_or_with_bun() {
        let dir = std::env::temp_dir().join(format!("wtx-fallback-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, text: &str| {
            let path = dir.join(name);
            std::fs::write(&path, text).unwrap();
            path
        };
        assert_eq!(runtime(&file("a.mjs", "#!/usr/bin/env bun\nx")), ["/usr/bin/env", "bun"]);
        assert_eq!(runtime(&file("b.mjs", "#!/usr/bin/env node\nx")), ["/usr/bin/env", "node"]);
        assert_eq!(runtime(&file("c.mjs", "console.log(1)")), ["bun"]);
        assert_eq!(runtime(&dir.join("missing.mjs")), ["bun"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
