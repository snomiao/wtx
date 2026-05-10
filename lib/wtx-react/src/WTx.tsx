/**
 * WorkspaceTerminal — xterm.js terminal connected via WebSocket.
 *
 * No tmux — text selection, scroll, and copy all work natively.
 *
 * Features:
 * - VS Code Light/Dark Modern themes with system auto-switch
 * - OSC 11 background color query response (dark/light detection for shell programs)
 * - VT theme change notification (CSI ? 997 ; 1/2 h) on system theme switch
 * - CJK double-width (Unicode11Addon)
 * - Clickable URLs with wrapped-URL reconstruction
 * - DOM rendering (for browser extension compatibility, e.g. 10ten Japanese Reader)
 * - Auto-copy on selection, Cmd+C/V clipboard
 * - ResizeObserver for responsive fit
 * - Auto-reconnect on disconnect (2s)
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

type ITheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];

export interface WTxProps {
  /** WebSocket URL path or full URL (e.g. "/api/terminal") */
  wsUrl: string;
  /** Working directory for the terminal session */
  cwd?: string;
  /** Attach to an existing named session (e.g. "agent-123") */
  session?: string;
  /** Called when the shell changes directory (OSC 7) */
  onCwdChange?: (cwd: string) => void;
  /** Command to send to the terminal once the WebSocket connection opens */
  initialCmd?: string;
  /** Called whenever the terminal receives output from the server */
  onActivity?: () => void;
  /** Override the dark theme (defaults to VS Code Dark Modern) */
  darkTheme?: ITheme;
  /** Override the light theme (defaults to VS Code Light Modern) */
  lightTheme?: ITheme;
  /** Wrapper className (default fills container) */
  className?: string;
}

// VS Code "Light Modern" terminal theme
const defaultLightTheme: ITheme = {
  background: "#ffffff",
  foreground: "#3b3b3b",
  cursor: "#005fb8",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionForeground: "#3b3b3b",
  selectionInactiveBackground: "#d4d4d4",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

// VS Code "Dark Modern" terminal theme
const defaultDarkTheme: ITheme = {
  background: "#1f1f1f",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1f1f1f",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "#3a3d41",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const prefersDark =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

// Convert #rrggbb to OSC rgb:RRRR/GGGG/BBBB (16-bit per channel, duplicate byte)
function hexToOscRgb(hex: string): string {
  const r = hex.slice(1, 3);
  const g = hex.slice(3, 5);
  const b = hex.slice(5, 7);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

export default function WTx({
  wsUrl,
  cwd,
  session,
  onCwdChange,
  initialCmd,
  onActivity,
  darkTheme = defaultDarkTheme,
  lightTheme = defaultLightTheme,
  className = "",
}: WTxProps) {
  const getTheme = (): ITheme => (prefersDark?.matches ? darkTheme : lightTheme);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "reconnecting" | "ended">(
    "connecting",
  );

  useEffect(() => {
    if (!containerRef.current) return;
    // Wait until cwd (or an explicit session) is known. Connecting without
    // either makes the server reject the WS, and previously caused a stray
    // ~/ws fallback session to be created.
    if (wsUrl === "/api/terminal" && !cwd && !session) return;
    let disposed = false;

    const init = async () => {
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        lineHeight: 1.2,
        allowProposedApi: true,
        rightClickSelectsWord: true,
        scrollback: 10000,
        fontFamily:
          "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', 'Menlo', 'Monaco', 'Courier New', 'Noto Sans Mono CJK SC', monospace",
        theme: getTheme(),
        // Override the built-in OSC 8 hyperlink handler so it does NOT show
        // the default `window.confirm("Do you want to navigate to …")` prompt.
        linkHandler: {
          activate(_event, text) {
            window.open(text, "_blank", "noopener");
          },
        },
      });

      // Theme auto-switch
      const onThemeChange = () => {
        term.options.theme = getTheme();
        if (wrapperRef.current) {
          wrapperRef.current.style.backgroundColor = getTheme()?.background ?? "#000000";
        }
        // Notify shell programs of theme change via VT sequence (CSI ? 997 ; 1/2 h)
        // 1 = dark, 2 = light
        const mode = prefersDark?.matches ? "1" : "2";
        wsRef.current?.send(`\x1b[?997;${mode}h`);
      };
      prefersDark?.addEventListener("change", onThemeChange);

      // --- Addons ---
      const fitAddon = new FitAddon();
      const unicode11Addon = new Unicode11Addon();
      // Clickable URLs — reconstruct URLs that wrap across terminal lines.
      // range.start.y is viewport-relative; add buf.viewportY for absolute buffer row.
      // isWrapped on row N means row N is a continuation of row N-1.
      const webLinksAddon = new WebLinksAddon(((
        _event: MouseEvent,
        uri: string,
        range: { start: { y: number } },
      ) => {
        let fullUrl = uri;
        try {
          const buf = term.buffer.active;
          const startRow = range.start.y + buf.viewportY; // absolute buffer row
          for (let row = startRow + 1; row < buf.length; row++) {
            const line = buf.getLine(row);
            if (!line || !line.isWrapped) break;
            fullUrl += line.translateToString(true);
          }
          fullUrl = fullUrl.replace(/[\s\x00-\x1f]+$/, "");
        } catch {
          /* fallback to uri */
        }
        window.open(fullUrl, "_blank", "noopener");
      }) as any);
      const searchAddon = new SearchAddon();
      const clipboardAddon = new ClipboardAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(unicode11Addon);
      term.loadAddon(webLinksAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(clipboardAddon);
      term.unicode.activeVersion = "11";

      term.open(containerRef.current!);

      // --- OSC 11: background color query (used by shell programs for dark/light detection) ---
      // Programs send \e]11;?\a to query background; we reply via the PTY input path (wsRef).
      term.parser.registerOscHandler(11, (data) => {
        if (data === "?") {
          const bg = getTheme()?.background ?? "#000000";
          const reply = `\x1b]11;${hexToOscRgb(bg)}\x1b\\`;
          wsRef.current?.send(reply);
        }
        return true;
      });

      // --- Clipboard ---
      // Auto-copy on selection (like iTerm2)
      term.onSelectionChange(() => {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      });

      let ws: WebSocket | null = null;
      const setWs = (w: WebSocket | null) => {
        ws = w;
        wsRef.current = w;
      };

      // Ctrl/Cmd+C: copy selection if selected, otherwise send SIGINT
      // Paste is handled natively by xterm.js via the browser paste event
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key === "c") {
          if (term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection()).catch(() => {});
            term.clearSelection();
            return false;
          }
        }
        return true;
      });

      // Expose for debugging
      (window as any).__term = term;
      (window as any).__fitAddon = fitAddon;

      // --- Fit ---
      let fitRaf = 0;
      const debouncedFit = () => {
        cancelAnimationFrame(fitRaf);
        fitRaf = requestAnimationFrame(() => {
          if (disposed) return;
          const buf = term.buffer.active;
          const wasAtBottom = buf.baseY + term.rows >= buf.length;
          fitAddon.fit();
          if (wasAtBottom) term.scrollToBottom();
        });
      };

      await document.fonts.ready;
      // Wait for container dimensions to stabilise (mobile browsers may report
      // 0 or tiny height on early frames while flex layout settles).
      let stableCount = 0,
        lastStableH = 0;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        if (disposed) {
          term.dispose();
          return;
        }
        const { clientWidth, clientHeight } = containerRef.current ?? {};
        if (clientWidth && clientHeight && clientHeight === lastStableH) {
          if (++stableCount >= 3) break;
        } else {
          stableCount = 0;
          lastStableH = clientHeight ?? 0;
        }
      }
      if (disposed) {
        term.dispose();
        return;
      }
      fitAddon.fit();
      // Belt-and-suspenders: force refit at 300 ms and 800 ms after init in
      // case ResizeObserver doesn't fire on mobile (e.g. Firefox Android).
      setTimeout(() => {
        if (!disposed) fitAddon.fit();
      }, 300);
      setTimeout(() => {
        if (!disposed) fitAddon.fit();
      }, 800);

      // --- WebSocket ---
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const base =
        wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://")
          ? wsUrl
          : `${protocol}//${window.location.host}${wsUrl}`;
      const params = new URLSearchParams({
        cols: String(term.cols),
        rows: String(term.rows),
        ...(cwd && { cwd }),
        ...(session && { session }),
      });
      const absUrl = `${base}?${params}`;

      term.onData((data) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      });

      term.onResize(({ cols, rows }) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "resize", cols, rows }));
        }
      });

      // Heartbeat: ping every 10s; if no pong within 8s, force-reconnect.
      // Catches zombie sockets where readyState=OPEN but data doesn't flow.
      let heartbeatInterval: number | undefined;
      let pongTimer: number | undefined;
      const HEARTBEAT_MS = 10_000;
      const PONG_TIMEOUT_MS = 8_000;
      const stopHeartbeat = () => {
        if (heartbeatInterval) window.clearInterval(heartbeatInterval);
        if (pongTimer) window.clearTimeout(pongTimer);
        heartbeatInterval = undefined;
        pongTimer = undefined;
      };
      const startHeartbeat = () => {
        stopHeartbeat();
        heartbeatInterval = window.setInterval(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
          if (pongTimer) window.clearTimeout(pongTimer);
          pongTimer = window.setTimeout(() => {
            // No pong — treat connection as dead. Closing triggers onclose → reconnect.
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
          }, PONG_TIMEOUT_MS);
        }, HEARTBEAT_MS);
      };

      const connect = () => {
        if (disposed) return;
        const newWs = new WebSocket(absUrl);
        setWs(newWs);
        newWs.binaryType = "arraybuffer";

        newWs.onopen = () => {
          setWsStatus("connected");
          debouncedFit();
          newWs.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          if (initialCmd) newWs.send(initialCmd + "\n");
          startHeartbeat();
        };

        newWs.onmessage = (e) => {
          onActivityRef.current?.();
          if (typeof e.data === "string") {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === "pong") {
                if (pongTimer) window.clearTimeout(pongTimer);
                pongTimer = undefined;
                return;
              }
              if (msg.type === "cwd" && msg.path) {
                onCwdChangeRef.current?.(msg.path);
                (window as any).__termCwd = msg.path;
                return;
              }
            } catch {
              // not a control message — fall through
            }
            term.write(e.data);
          } else {
            term.write(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
          }
        };

        newWs.onclose = (ev) => {
          stopHeartbeat();
          if (disposed) return;
          // Server closed because the session is gone (1000 normal, 1008 policy).
          // Don't reconnect — the buffer/logs were already replayed.
          if (ev.code === 1000 || ev.code === 1008) {
            setWsStatus("ended");
            return;
          }
          setWsStatus("reconnecting");
          setTimeout(connect, 2000);
        };

        newWs.onerror = () => {
          setWsStatus("reconnecting");
        };
      };

      connect();

      // --- ResizeObserver ---
      const observer = new ResizeObserver(debouncedFit);
      if (wrapperRef.current) observer.observe(wrapperRef.current);

      // Periodic refit fallback
      let lastW = 0;
      let lastH = 0;
      const fitInterval = setInterval(() => {
        if (disposed || !wrapperRef.current) return;
        const { clientWidth: w, clientHeight: h } = wrapperRef.current;
        if (w !== lastW || h !== lastH) {
          lastW = w;
          lastH = h;
          fitAddon.fit();
        }
      }, 300);

      // Initial wrapper background
      if (wrapperRef.current) {
        wrapperRef.current.style.backgroundColor = getTheme()?.background ?? "#000000";
      }

      return () => {
        disposed = true;
        stopHeartbeat();
        cancelAnimationFrame(fitRaf);
        clearInterval(fitInterval);
        observer.disconnect();
        prefersDark?.removeEventListener("change", onThemeChange);
        ws?.close();
        setWs(null);
        term.dispose();
      };
    };

    let cleanup: (() => void) | undefined;
    init().then((fn) => {
      cleanup = fn;
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [wsUrl, cwd, session]);

  return (
    <div
      ref={wrapperRef}
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        minHeight: 0,
      }}
    >
      <div
        ref={containerRef}
        style={{ position: "absolute", inset: 0 }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {wsStatus !== "connected" && (
        <div
          data-testid="ws-status-badge"
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            padding: "4px 10px",
            fontSize: 12,
            fontFamily: "monospace",
            borderRadius: 4,
            background:
              wsStatus === "reconnecting"
                ? "#b58900"
                : wsStatus === "ended"
                  ? "#586e75"
                  : "#268bd2",
            color: "#fff",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          {wsStatus === "reconnecting"
            ? "reconnecting…"
            : wsStatus === "ended"
              ? "session ended"
              : "connecting…"}
        </div>
      )}
    </div>
  );
}
