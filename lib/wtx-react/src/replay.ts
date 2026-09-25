/** Replay output can contain queries. It must never act as fresh user input. */
export class TerminalReplay {
  acceptingInput = true;
  private generation = 0;
  constructor(private readonly term: {
    reset(): void;
    write(data: string, callback?: () => void): void;
    options: { disableStdin?: boolean };
  }) {}
  begin(): void {
    this.generation++;
    this.acceptingInput = false;
    this.term.options.disableStdin = true;
    this.term.reset();
  }
  end(): void {
    const generation = this.generation;
    // xterm parses writes asynchronously: a WebSocket end marker alone is
    // insufficient. Wait until the last replay byte has actually been parsed.
    this.term.write("", () => {
      if (generation !== this.generation) return;
      this.acceptingInput = true;
      this.term.options.disableStdin = false;
    });
  }
}
