import { useEffect, useRef, useState } from "react";
import { Terminal, type ITerminalOptions, type ITerminalInitOnlyOptions } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

export interface UseWTxOptions {
  /** Forwarded to `new Terminal(options)`. Captured on mount; later changes are ignored. */
  options?: ITerminalOptions & ITerminalInitOnlyOptions;
  /** Skip loading the default addon bundle (FitAddon + Unicode11 + WebLinks + Search + Clipboard). */
  skipDefaultAddons?: boolean;
}

export interface UseWTxResult {
  /** Terminal instance — null until the ref is attached and the terminal is opened. */
  instance: Terminal | null;
  /** Attach this ref to the host `<div>`. */
  ref: React.RefObject<HTMLDivElement | null>;
  /** FitAddon attached to the terminal (null until ready, or when `skipDefaultAddons`). */
  fitAddon: FitAddon | null;
}

/**
 * Headless xterm.js hook — gives you a `Terminal` + container ref so you can
 * stream data via `instance.write(...)` from any source (HTTP fetch, EventSource, etc.).
 *
 * For an interactive PTY session over WebSocket, use `<WTx>` instead.
 */
export function useWTx({ options, skipDefaultAddons }: UseWTxOptions = {}): UseWTxResult {
  const ref = useRef<HTMLDivElement | null>(null);
  const [instance, setInstance] = useState<Terminal | null>(null);
  const [fitAddon, setFitAddon] = useState<FitAddon | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal(options);
    let fit: FitAddon | null = null;
    if (!skipDefaultAddons) {
      fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.loadAddon(new WebLinksAddon());
      term.loadAddon(new SearchAddon());
      term.loadAddon(new ClipboardAddon());
      term.unicode.activeVersion = "11";
    }
    term.open(ref.current);
    setInstance(term);
    setFitAddon(fit);
    return () => {
      term.dispose();
      setInstance(null);
      setFitAddon(null);
    };
    // Options/addons captured at mount — matches react-xtermjs behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { instance, ref, fitAddon };
}

export default useWTx;
