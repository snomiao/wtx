## [0.0.2](https://github.com/snomiao/wtx/compare/v0.0.1...v0.0.2) (2026-05-12)


### Bug Fixes

* **release:** use exec for publish (npm token check bypass for OIDC) ([4cb0f60](https://github.com/snomiao/wtx/commit/4cb0f604b67bcce03ae11e5657781b4b7a477fc1))

# Changelog

## 0.0.1 (unreleased)

Initial release. Extracted from sno-codehost.

- Bun PTY WebSocket server with 1MB-per-session replay buffer
- Tmux-free session management — multi-tab works via in-memory session map
- Backpressure-aware broadcast (skips slow clients instead of blocking the event loop)
- Graceful "session ended" — close code 1000 with full log replay for finished sessions, no client reconnect-loop
- Heartbeat ping/pong to detect dead connections
- HTTP endpoints: `GET /sessions`, `GET /sessions/:key/buffer`, `GET /summary?cwd=`, `GET /status/:owner/:repo` (when `WTX_REPO_BASE` is set)
- `wtx` CLI launches the server using env config
