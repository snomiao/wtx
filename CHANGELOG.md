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
