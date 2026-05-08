# wtx

Web terminal for Bun + React. Two packages:

| Package               | npm         | Purpose                                                  |
| --------------------- | ----------- | -------------------------------------------------------- |
| [`server/`](./server) | `wtx`       | Bun PTY WebSocket server with replay buffer + `wtx` CLI  |
| [`react/`](./react)   | `wtx-react` | xterm.js React component with auto-reconnect & heartbeat |

## Why

- Bun PTY backend (no tmux dependency)
- Replay buffer so reconnects pick up where they left off
- Backpressure-aware broadcast (skips slow clients instead of blocking the event loop)
- Graceful "session ended" handling — close code 1000 with full log replay for finished sessions, no reconnect-loop on the client
- Heartbeat ping/pong to detect dead connections

## Repo

<https://github.com/snomiao/wtx>

## Status

Early — extracted from `sno-codehost` and decoupled from host integrations. API may shift before 1.0.
