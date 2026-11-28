//! The parts of wtx that are ported to Rust, as modules the binary does not
//! use yet.
//!
//! wtx is one long-running server, and the binary cannot hand a request
//! back to the JavaScript once it has started listening: it either answers
//! every request exactly as src/server.ts and Bun.serve do, or it hands the
//! whole invocation back before it starts (rs/src/main.rs, which for now
//! always does). These modules are the server's logic, each proven against
//! the TypeScript's own functions run by bun (rs/parity/record.ts writes
//! what they answered into rs/src/testdata, and the tests here compare):
//!
//! - [`js`]: what the TypeScript takes from JavaScript (parseInt, String of a
//!   number, JSON strings, trim, decodeURIComponent, URLSearchParams,
//!   TextDecoder);
//! - [`term_summary`]: src/term-summary.ts, what `/summary` says;
//! - [`server`]: the pieces of src/server.ts (session keys, working
//!   directories, sizes, the replay buffer, OSC 7, the PTY's environment,
//!   `/status`, the fallback renderer);
//! - [`api`]: the HTTP and WebSocket handlers over a table of sessions, with
//!   the PTY, git, the clock and the clients as stand-ins.
//!
//! What is not here, and keeps the server in the JavaScript: rendering a
//! screen as @xterm/headless does (`?strip=1`, `tail`, `offset`,
//! `/summary`), Bun.serve's own HTTP and WebSocket handling and its error
//! pages, bun's loading of .env files, and a PTY.

pub mod api;
pub mod js;
pub mod server;
pub mod term_summary;

#[cfg(test)]
mod testdata;
