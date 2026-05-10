# Changelog

## 0.0.1 (unreleased)

Initial release. Extracted from sno-codehost.

- `<WTx>` React component wrapping xterm.js + WebSocket client
- Auto-reconnect with backoff; close codes 1000 (normal) and 1008 (policy) skip reconnect and show a "session ended" badge
- Heartbeat ping/pong (8s pong timeout)
- Fit-to-container with `ResizeObserver`
- VS Code Light/Dark Modern themes with system auto-switch (overridable via `darkTheme`/`lightTheme` props)
- OSC 11 background color reply for shell programs
- VT theme change notification (CSI ?997;1/2 h) on system theme switch
- CJK double-width via Unicode11 addon
- Clickable URLs with wrapped-line reconstruction
- Auto-copy on selection
