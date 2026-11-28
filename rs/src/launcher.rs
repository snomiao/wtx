//! A run that the npm package's launcher started, under bun.
//!
//! Until its first run, the `wtx` an npm install gives is rustify's launcher
//! (`<package>/rustify/wtx`, a script that starts with `#!/usr/bin/env bun`).
//! That run puts this binary in its place and starts it, with the launcher's
//! environment and WTX_PACKAGE_ROOT set to the package. Where the launcher
//! cannot put the binary in its place (RUSTIFY_NO_LINK=1, a package
//! directory it may not write to, Yarn's Plug'n'Play, or a Windows command
//! shim it does not know), every run goes that way.
//!
//! bun has done its own work before the launcher's first line:
//!
//! - it has read the .env files of the working directory into the
//!   environment the launcher passes on. For wtx.mjs, bun reads them into
//!   `process.env` only, and a terminal session gets the server's real
//!   environment, which does not have them. Passed on by the launcher they
//!   are real, and every session would get them, TERMINAL_ACCESS_KEY and
//!   any secret there included; and NODE_ENV set there would make the
//!   server's bun read other .env files than wtx.mjs's does;
//! - it has run the preloads of a bunfig.toml there and of BUN_OPTIONS,
//!   which the server's bun would run a second time;
//! - it has acted on the variables that make it write on its own
//!   (BUN_JSC_*, MIMALLOC_*), which the server's bun would do again.
//!
//! None of that can be undone here: a variable that came from .env looks
//! like one of the user's own. So when the launcher started this run and any
//! of those is there, the binary starts nothing and says so (`check`). It
//! hands everything else back, as it did before.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The .env files bun reads from the working directory: `.env`, and
/// `.env.local` (not under NODE_ENV=test), `.env.development` and
/// `.env.development.local`, or the production or test ones under that
/// NODE_ENV (bun 1.4). Which NODE_ENV the launcher's bun had cannot be told
/// afterwards, when .env itself sets it, so all of them count.
pub const ENV_FILES: [&str; 8] = [
    ".env",
    ".env.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
    ".env.test",
    ".env.test.local",
];

/// bun's own configuration in the working directory.
pub const BUNFIG: &str = "bunfig.toml";

/// Whether the launcher started this run: WTX_PACKAGE_ROOT names the
/// package this binary belongs to, and that is an installed package, which
/// has the launcher's directory (`rustify/`, with the package.json the packer
/// puts there). A checkout, or the parity runner's stand-in, has none.
pub fn started_by_launcher(root: &Path) -> bool {
    crate::js_fallback::names_root(root) && root.join("rustify").join("package.json").is_file()
}

/// Whether this binary is the one in the launcher's place, `<package>/rustify/`
/// (so the next run does not go through the launcher), rather than the one in
/// the platform package that the launcher starts when it cannot link.
fn in_launchers_place(root: &Path) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let place = root.join("rustify");
    let place = std::fs::canonicalize(&place).unwrap_or(place);
    exe.parent() == Some(place.as_path())
}

/// What bun has applied before the launcher ran, and the server's bun would
/// apply again: the files of `cwd` (`None`: the working directory could not
/// be read, which counts as having them) and the variables, by name.
pub fn applied(cwd: Option<&Path>, vars: impl IntoIterator<Item = (OsString, OsString)>, windows: bool) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    match cwd {
        Some(dir) => {
            for name in ENV_FILES.iter().chain(std::iter::once(&BUNFIG)) {
                if std::fs::symlink_metadata(dir.join(name)).is_ok() {
                    found.push((*name).to_string());
                }
            }
        }
        None => found.push("the working directory's files (it cannot be read)".to_string()),
    }
    let mut names: Vec<String> = vars
        .into_iter()
        .filter_map(|(name, _)| name.into_string().ok())
        .filter(|name| {
            // Windows reads a variable's name without regard to case.
            let name = if windows { name.to_ascii_uppercase() } else { name.clone() };
            name == "BUN_OPTIONS" || name.starts_with("BUN_JSC_") || name.starts_with("MIMALLOC_")
        })
        .collect();
    names.sort();
    found.extend(names);
    found
}

/// The message for a run the binary does not start.
pub fn message(applied: &[String], in_place: bool, root: &Path) -> String {
    let mut text = format!(
        "wtx: not started: bun ran the npm package's launcher first, and has already applied {}. \
         wtx would pass that on to every terminal session, and its bun would apply it a second time.\n",
        applied.join(", ")
    );
    if in_place {
        text.push_str("Run wtx again: it now starts without the launcher.\n");
    } else {
        let script: PathBuf = root.join("wtx.mjs");
        text.push_str(&format!(
            "The launcher cannot put the binary in its place here (RUSTIFY_NO_LINK, or a package directory it may not write to), \
             so every run goes through it: start wtx with bun instead, bun \"{}\"\n",
            script.display()
        ));
    }
    text
}

/// `Some(message)` when the launcher started this run and bun has applied
/// something there that wtx would pass on: then nothing is to be started.
pub fn check(root: &Path) -> Option<String> {
    if !started_by_launcher(root) {
        return None;
    }
    let cwd = std::env::current_dir().ok();
    let found = applied(cwd.as_deref(), std::env::vars_os(), cfg!(windows));
    (!found.is_empty()).then(|| message(&found, in_launchers_place(root), root))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(list: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        list.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()
    }

    #[test]
    fn what_bun_has_applied_is_named() {
        let dir = std::env::temp_dir().join(format!("wtx-launcher-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let none = vars(&[("PATH", "/bin"), ("NODE_ENV", "production"), ("NODE_OPTIONS", "--require x"), ("BUN_INSTALL", "/b"), ("bun_options", "x")]);
        assert!(applied(Some(&dir), none.clone(), false).is_empty(), "nothing bun reads is there");
        // Files bun does not read.
        for name in [".env.example", ".envrc", "env", ".env.staging", "package.json", "tsconfig.json"] {
            std::fs::write(dir.join(name), "X=1\n").unwrap();
        }
        assert!(applied(Some(&dir), none.clone(), false).is_empty());
        std::fs::write(dir.join(".env.production"), "").unwrap();
        std::fs::create_dir(dir.join("bunfig.toml")).unwrap();
        assert_eq!(applied(Some(&dir), none.clone(), false), [".env.production", "bunfig.toml"]);
        let set = vars(&[("MIMALLOC_VERBOSE", "1"), ("BUN_OPTIONS", ""), ("BUN_JSC_logGC", "1"), ("BUN_CONFIG_X", "1")]);
        assert_eq!(applied(Some(&dir), set, false), [".env.production", "bunfig.toml", "BUN_JSC_logGC", "BUN_OPTIONS", "MIMALLOC_VERBOSE"]);
        // On Windows a variable's name has no case.
        assert_eq!(applied(Some(&dir), vars(&[("bun_options", "x")]), true), [".env.production", "bunfig.toml", "bun_options"]);
        assert_eq!(applied(None, Vec::new(), false), ["the working directory's files (it cannot be read)"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_message_says_what_to_do() {
        let root = Path::new("/pkg");
        let found = [".env".to_string(), "BUN_OPTIONS".to_string()];
        assert_eq!(
            message(&found, true, root),
            "wtx: not started: bun ran the npm package's launcher first, and has already applied .env, BUN_OPTIONS. \
             wtx would pass that on to every terminal session, and its bun would apply it a second time.\n\
             Run wtx again: it now starts without the launcher.\n"
        );
        assert!(message(&found, false, root).ends_with(&format!("start wtx with bun instead, bun \"{}\"\n", root.join("wtx.mjs").display())));
    }
}
