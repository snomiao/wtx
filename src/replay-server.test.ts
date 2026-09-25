import {test, expect} from "bun:test";

test("server brackets reconnect history with replay control frames", async () => {
  const previousPort = process.env.TERMINAL_WS_PORT;
  process.env.TERMINAL_WS_PORT = "0";
  const {startTerminalWS, createSession} = await import("./server");
  if (previousPort === undefined) delete process.env.TERMINAL_WS_PORT;
  else process.env.TERMINAL_WS_PORT = previousPort;
  const server = startTerminalWS();
  const session = createSession("replay-test", [process.execPath, "-e",
    "process.stdout.write('REPLAY_READY'); setInterval(() => {}, 1000)"], 80, 24, process.cwd());
  let socket: WebSocket | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!new TextDecoder().decode(Buffer.concat(session.buffer)).includes("REPLAY_READY")) {
      if (Date.now() > deadline) throw new Error("PTY did not become ready");
      await Bun.sleep(20);
    }
    const frames: Array<string | Uint8Array> = [];
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Replay timed out")), 5000);
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/?session=replay-test`);
      socket.binaryType = "arraybuffer";
      socket.onmessage = event => {
        frames.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
        if (typeof event.data === "string" && JSON.parse(event.data).type === "replay-end") {
          clearTimeout(timeout); resolve();
        }
      };
      socket.onerror = () => {clearTimeout(timeout); reject(new Error("WebSocket failed"));};
    });
    expect(JSON.parse(frames[0] as string).type).toBe("replay-start");
    expect(JSON.parse(frames.at(-1) as string).type).toBe("replay-end");
    expect(new TextDecoder().decode(Buffer.concat(frames.filter(f => f instanceof Uint8Array) as Uint8Array[]))).toContain("REPLAY_READY");
  } finally {
    socket?.close();
    session.pty.kill();
    server.stop(true);
  }
}, 15000);
