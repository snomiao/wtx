# [0.3.0](https://github.com/snomiao/wtx/compare/v0.2.0...v0.3.0) (2026-05-15)


### Features

* **wtx-react:** re-export Terminal/ITerminalAddon/IDisposable types from @xterm/xterm ([4c81a81](https://github.com/snomiao/wtx/commit/4c81a81970d1b90e62b73f89ddf9bcd6cb61300e))

# [0.2.0](https://github.com/snomiao/wtx/compare/v0.1.0...v0.2.0) (2026-05-12)


### Features

* **wtx-react:** add useWTx headless hook for log viewers ([9ec493d](https://github.com/snomiao/wtx/commit/9ec493d4b1d5c4a4b63014953f75687fbf7b20a1))

# [0.1.0](https://github.com/snomiao/wtx/compare/v0.0.5...v0.1.0) (2026-05-12)


### Features

* **server:** add POST/DELETE /sessions/:key for external session control ([2bc6af7](https://github.com/snomiao/wtx/commit/2bc6af7fd9a2628df88597058b95981b7f6b9a5c))

## [0.0.5](https://github.com/snomiao/wtx/compare/v0.0.4...v0.0.5) (2026-05-12)


### Bug Fixes

* trigger first successful OIDC trusted publish ([d19371e](https://github.com/snomiao/wtx/commit/d19371e09ac5ef18738cad8f66c018e44a39119f))

## [0.0.4](https://github.com/snomiao/wtx/compare/v0.0.3...v0.0.4) (2026-05-12)


### Bug Fixes

* **release:** upgrade npm to latest for OIDC support ([e55bb5e](https://github.com/snomiao/wtx/commit/e55bb5e7b306f734e4e38adbd3776fd2aef73064))
* **release:** use Node 24 (npm 11.x bundled) for OIDC support ([2a5b971](https://github.com/snomiao/wtx/commit/2a5b9712723df39e407e4840fe2de0ac8252cd62))

## [0.0.3](https://github.com/snomiao/wtx/compare/v0.0.2...v0.0.3) (2026-05-12)


### Bug Fixes

* **release:** drop setup-node registry-url to enable OIDC fallback ([f90511a](https://github.com/snomiao/wtx/commit/f90511a2f5d5153c843c5bfb73a519adc712a452))

## [0.0.2](https://github.com/snomiao/wtx/compare/v0.0.1...v0.0.2) (2026-05-12)


### Bug Fixes

* **release:** use exec for publish (npm token check bypass for OIDC) ([4cb0f60](https://github.com/snomiao/wtx/commit/4cb0f604b67bcce03ae11e5657781b4b7a477fc1))
* retry 0.0.2 release (revert failed TLOG run) ([5f20370](https://github.com/snomiao/wtx/commit/5f20370a31be444b834c44c6db8d4c62c2b6826f))

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
