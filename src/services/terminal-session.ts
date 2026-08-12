// @xterm/headless ships a CommonJS build; under Node ESM the default import
// yields the whole module.exports object (which holds the Terminal class).
import xtermHeadless from "@xterm/headless";
import type {
  Terminal as TerminalInstance,
  ITerminalOptions,
  ITerminalInitOnlyOptions,
} from "@xterm/headless";
import type { ClientChannel } from "ssh2";
import { Logger } from "../utils/logger.js";

const TerminalCtor = (
  xtermHeadless as unknown as {
    Terminal: new (
      options: ITerminalOptions & ITerminalInitOnlyOptions,
    ) => TerminalInstance;
  }
).Terminal;

/**
 * Default terminal dimensions. A large window is required by some bastion
 * TUI portals (e.g. UGATE-PORTAL) which refuse to render their menu when the
 * pty is too small.
 */
export const DEFAULT_TERMINAL_COLS = 200;
export const DEFAULT_TERMINAL_ROWS = 50;
const DEFAULT_SCROLLBACK = 5000;

/** Mapping of human-readable special key names to the bytes sent to the pty. */
const SPECIAL_KEYS: Record<string, string> = {
  Enter: "\r",
  Return: "\r",
  Escape: "\x1b",
  Esc: "\x1b",
  Tab: "\t",
  Backspace: "\x7f",
  Space: " ",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  F1: "\x1bOP",
  F2: "\x1bOQ",
  F3: "\x1bOR",
  F4: "\x1bOS",
  F5: "\x1b[15~",
  F6: "\x1b[17~",
  F7: "\x1b[18~",
  F8: "\x1b[19~",
  F9: "\x1b[20~",
  F10: "\x1b[21~",
  F11: "\x1b[23~",
  F12: "\x1b[24~",
};

/** Render a key token (special name, Ctrl+X, or raw text) into pty bytes. */
export function renderKey(token: string): string {
  if (token in SPECIAL_KEYS) {
    return SPECIAL_KEYS[token];
  }
  // Ctrl+<letter> / Ctrl+<digit> support, e.g. "Ctrl+C" -> 0x03
  const ctrlMatch = /^Ctrl\+(.+)$/i.exec(token);
  if (ctrlMatch) {
    const ch = ctrlMatch[1];
    if (ch.length === 1) {
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        return String.fromCharCode(code - 64);
      }
    }
  }
  // Alt+<char> sends ESC then the char
  const altMatch = /^Alt\+(.+)$/i.exec(token);
  if (altMatch) {
    return "\x1b" + altMatch[1];
  }
  // Otherwise treat the token as literal text.
  return token;
}

export interface ScreenSnapshot {
  /** Visible screen text, one line per row (trailing whitespace trimmed per line). */
  screen: string;
  /** Cursor column (0-based). */
  cursorX: number;
  /** Cursor row (0-based). */
  cursorY: number;
  /** Current pty width in columns. */
  cols: number;
  /** Current pty height in rows. */
  rows: number;
}

/**
 * An interactive terminal session backed by an SSH shell stream and a
 * headless xterm.js emulator. The emulator maintains an accurate screen
 * buffer so callers can "see" what a TUI (menus, curses apps, shells)
 * currently displays, and send keystrokes to drive it.
 */
export class TerminalSession {
  private term: TerminalInstance;
  private stream: ClientChannel;
  private cols: number;
  private rows: number;
  private pendingWrite: Promise<void> = Promise.resolve();
  private lastDataTime = 0;
  private closed = false;

  constructor(stream: ClientChannel, cols: number, rows: number) {
    this.stream = stream;
    this.cols = cols;
    this.rows = rows;
    this.term = new TerminalCtor({
      cols,
      rows,
      scrollback: DEFAULT_SCROLLBACK,
      allowProposedApi: true,
    });

    // Forward emulator-generated output (responses to terminal queries such as
    // cursor-position reports \x1b[6n or device-attribute requests) back to the
    // remote pty. Many TUI/bastion portals block rendering until they receive
    // these responses, so without this forwarding the screen stays blank.
    this.term.onData((data: string) => {
      if (this.closed) return;
      try {
        this.stream.write(data);
      } catch {
        // Ignore write errors on a closing stream.
      }
    });

    stream.on("data", (chunk: Buffer) => {
      this.feed(chunk.toString("utf8"));
    });
    stream.on("close", () => {
      this.closed = true;
      Logger.log("Terminal session stream closed", "info");
    });
    stream.on("error", (err: Error) => {
      this.closed = true;
      Logger.log(`Terminal session stream error: ${err.message}`, "error");
    });
  }

  /** Feed remote output into the emulator (async parsing tracked via pendingWrite). */
  private feed(data: string): void {
    this.lastDataTime = Date.now();
    this.pendingWrite = this.pendingWrite.then(
      () =>
        new Promise<void>((resolve) => {
          this.term.write(data, () => resolve());
        }),
    );
  }

  /** Whether the underlying stream is still open. */
  isAlive(): boolean {
    return !this.closed;
  }

  /** Send keystrokes (already rendered to bytes) to the remote pty. */
  send(data: string): void {
    if (this.closed) {
      throw new Error("Terminal session is closed");
    }
    this.stream.write(data);
  }

  /**
   * Read the current visible screen. Awaits any pending emulator writes so the
   * snapshot reflects all output received so far.
   */
  async readScreen(): Promise<ScreenSnapshot> {
    await this.pendingWrite;
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.rows; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : "");
    }
    return {
      screen: lines.join("\n").replace(/\n+$/, ""),
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      cols: this.cols,
      rows: this.rows,
    };
  }

  /**
   * Wait for remote output to settle: returns once no new data has arrived
   * for `idleMs`, or after `maxWaitMs` elapses. If `requireData` is true the
   * wait continues until at least some data has arrived (useful for initial
   * render of TUI portals that take a few seconds to appear).
   */
  async waitForSettle(
    idleMs = 300,
    maxWaitMs = 5000,
    requireData = false,
  ): Promise<void> {
    const start = Date.now();
    const baseline = this.lastDataTime;
    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 50));
      const sinceData = Date.now() - this.lastDataTime;
      const gotNewData = this.lastDataTime > baseline;
      if (gotNewData && sinceData >= idleMs) {
        break;
      }
      if (!requireData && !gotNewData && sinceData >= idleMs) {
        // No data yet and quiet — either nothing will come or it hasn't started.
        // Keep waiting up to maxWaitMs so slow TUIs can still appear.
      }
    }
  }

  /**
   * Send keystrokes and wait for output to settle, then return the screen.
   * Settling = no new data for `idleMs` (default 300ms), capped at `maxWaitMs`
   * (default 5000ms). This lets TUI redraws and command output flush before
   * capturing the screen.
   */
  async sendAndRead(
    data: string,
    idleMs = 300,
    maxWaitMs = 5000,
  ): Promise<ScreenSnapshot> {
    this.send(data);
    await this.waitForSettle(idleMs, maxWaitMs, true);
    return this.readScreen();
  }

  /** Resize the pty and the emulator, notifying the remote side. */
  resize(cols: number, rows: number): void {
    if (this.closed) {
      throw new Error("Terminal session is closed");
    }
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    try {
      // Inform the remote pty of the new window size (rows, cols, height, width).
      this.stream.setWindow(rows, cols, rows * 16, cols * 8);
    } catch (err) {
      Logger.log(
        `Terminal resize setWindow failed: ${(err as Error).message}`,
        "error",
      );
    }
  }

  getDimensions(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  dispose(): void {
    this.closed = true;
    try {
      this.term.dispose();
    } catch {
      // Ignore dispose errors.
    }
    try {
      this.stream.close();
    } catch {
      // Ignore close errors.
    }
  }
}
