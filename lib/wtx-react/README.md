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

## `useWTx` — headless hook

For one-way log viewers (HTTP streams, `EventSource`, custom transports), use
the headless hook — it gives you a configured xterm `Terminal` + container ref,
with the same default addon bundle as `<WTx>` (Fit, Unicode11, WebLinks, Search,
Clipboard).

```tsx
import { useEffect } from "react";
import { useWTx } from "@snomiao/wtx-react";

export function LogViewer({ url }: { url: string }) {
  const { instance, ref } = useWTx({ options: { fontSize: 13, scrollback: 10000 } });

  useEffect(() => {
    if (!instance) return;
    const ac = new AbortController();
    (async () => {
      const res = await fetch(url, { signal: ac.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        instance.write(decoder.decode(value, { stream: true }));
      }
    })();
    return () => ac.abort();
  }, [instance, url]);

  return <div ref={ref} className="w-full h-full" />;
}
```

| option              | type                | description                                             |
| ------------------- | ------------------- | ------------------------------------------------------- |
| `options`           | `ITerminalOptions?` | forwarded to `new Terminal(opts)` (captured on mount)   |
| `skipDefaultAddons` | `boolean?`          | don't auto-load Fit/Unicode11/WebLinks/Search/Clipboard |

Returns `{ instance, ref, fitAddon }`. `instance` is `null` until the ref is
attached and the terminal opened.

## Repo

<https://github.com/snomiao/wtx>
