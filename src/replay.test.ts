import { test, expect } from "bun:test";
import { Terminal } from "@xterm/headless";
import { TerminalReplay } from "../lib/wtx-react/src/replay";

test("reconnect parses history without feeding historical query replies into the live PTY", async () => {
  const term = new Terminal({allowProposedApi: true});
  const replay = new TerminalReplay(term);
  const replies: string[] = [];
  term.onData(data => { if (replay.acceptingInput) replies.push(data); });
  try {
    replay.begin();
    term.write("old output\x1b[6n\x1b[c");
    replay.end();
    expect(replay.acceptingInput).toBe(false);
    await new Promise<void>(resolve => term.write("", resolve));
    expect(replies).toEqual([]);
    expect(replay.acceptingInput).toBe(true);
    await new Promise<void>(resolve => term.write("\x1b[6n", resolve));
    expect(replies).toHaveLength(1);
  } finally { term.dispose(); }
});

test("new replay resets modes and cannot be unlocked by an older completion", async () => {
  const term = new Terminal({allowProposedApi: true});
  const replay = new TerminalReplay(term);
  try {
    await new Promise<void>(resolve => term.write("\x1b[?1003h", resolve));
    expect(term.modes.mouseTrackingMode).toBe("any");
    replay.begin(); replay.end(); replay.begin();
    await new Promise<void>(resolve => term.write("", resolve));
    expect(replay.acceptingInput).toBe(false);
    expect(term.modes.mouseTrackingMode).toBe("none");
    replay.end();
    await new Promise<void>(resolve => term.write("", resolve));
    expect(replay.acceptingInput).toBe(true);
  } finally { term.dispose(); }
});
