# wtx

Bun PTY WebSocket server with replay buffer + `wtx` CLI.

## Install

```sh
bun add wtx
```

## Library usage

```ts
import { startTerminalWS, createSession } from "wtx";

startTerminalWS(); // listens on TERMINAL_WS_PORT (default 3004)
```

## CLI usage

```sh
bunx wtx   # or: bun ./node_modules/wtx/src/cli.ts
```

## Env

| var                | default         | purpose                                                               |
| ------------------ | --------------- | --------------------------------------------------------------------- |
| `TERMINAL_WS_PORT` | `3004`          | WS server port                                                        |
| `WTX_DEFAULT_CWD`  | `process.cwd()` | fallback cwd for new sessions                                         |
| `WTX_REPO_BASE`    | _(unset)_       | enables `/status/:owner/:repo` resolved under `<base>/<owner>/<repo>` |

## API

- `startTerminalWS()` — start the WS server
- `createSession(cwd, sessionKey?)` — create or attach to a tmux-free PTY session
- `hasSession(sessionKey)` — check if a session exists
- `getTerminalStatusForRepo(repoFolder)` — busy/idle status
- `getTermSummaryForCwd(cwd)` — terminal log summary

## Repo

<https://github.com/snomiao/wtx>
