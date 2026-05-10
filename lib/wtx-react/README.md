# wtx-react

React xterm.js terminal that pairs with [`wtx`](https://www.npmjs.com/package/wtx).

## Install

```sh
npm i wtx-react
# or
bun add wtx-react
```

## Usage

```tsx
import { WTx } from "wtx-react";

export function App() {
  return <WTx wsUrl="/api/terminal" cwd="/home/user/project" />;
}
```

## Props

| prop          | type                    | description                                             |
| ------------- | ----------------------- | ------------------------------------------------------- |
| `wsUrl`       | `string`                | WebSocket URL (relative is resolved against `location`) |
| `cwd`         | `string?`               | working directory hint sent to server                   |
| `session`     | `string?`               | explicit session key (overrides cwd-derived key)        |
| `onCwdChange` | `(cwd: string) => void` | fires on OSC7 cwd change                                |
| `onActivity`  | `() => void`            | fires on any output                                     |
| `darkTheme`   | `ITheme?`               | override the dark xterm theme                           |
| `lightTheme`  | `ITheme?`               | override the light xterm theme                          |
| `className`   | `string?`               | wrapper className                                       |

## Features

- Auto-reconnect with backoff (skipped on close codes 1000/1008 — "session ended")
- Heartbeat ping/pong (8s pong timeout)
- Fit-to-container with `ResizeObserver`
- Status badge (`connecting…` / `reconnecting…` / `session ended`)

## Repo

<https://github.com/snomiao/wtx>
