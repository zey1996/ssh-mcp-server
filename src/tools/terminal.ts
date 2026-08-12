import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { renderKey } from "../services/terminal-session.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";
import { AuditLogger } from "../utils/audit-logger.js";

const CONNECTION_NAME_DESC =
  "SSH connection name (optional, default is 'default')";

/**
 * Register the interactive terminal tools.
 *
 * These tools expose the persistent SSH shell (PTY) backed by a headless
 * xterm.js emulator. They let an agent drive interactive TUI applications
 * such as bastion/jump-server portals (e.g. UGATE-PORTAL), text menus,
 * curses apps, and interactive shells — anything that exec-based command
 * execution cannot handle.
 */
export function registerTerminalTools(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "terminal",
    {
      description:
        "Interact with the persistent SSH terminal: send keystrokes and read the resulting screen. Use this to drive interactive menus/TUI/bastion portals step by step — first read the screen to see the menu, then send the keys to choose an option, then read again. Pass `text` to type a string verbatim, or `keys` for special keys (e.g. Enter, Escape, F1, Up, Ctrl+C). Omit both to just read the current screen.",
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe(
            "Text to type verbatim into the terminal (e.g. a menu number or a shell command). Sent before any `keys`.",
          ),
        keys: z
          .array(z.string())
          .optional()
          .describe(
            "Special keys to send after `text`. Each entry is a key name: Enter, Escape, Tab, Backspace, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, Delete, F1-F12, or Ctrl+X (e.g. Ctrl+C), Alt+X. A plain string entry is sent as literal text.",
          ),
        waitMs: z
          .number()
          .optional()
          .describe(
            "Maximum milliseconds to wait for output to settle after sending (default 5000). The tool returns as soon as output goes quiet for ~300ms.",
          ),
        connectionName: z.string().optional().describe(CONNECTION_NAME_DESC),
      },
    },
    async ({ text, keys, waitMs, connectionName }) => {
      const start = Date.now();
      const auditInput = { text, keys, waitMs };
      try {
        const session = await sshManager.getTerminalSession(connectionName);

        // Build the byte payload: literal text first, then special keys.
        let payload = "";
        if (text) {
          payload += text;
        }
        if (keys && keys.length > 0) {
          for (const token of keys) {
            payload += renderKey(token);
          }
        }

        const snapshot = payload
          ? await session.sendAndRead(payload, 300, waitMs ?? 5000)
          : await session.readScreen();

        AuditLogger.log({
          tool: "terminal",
          connection: connectionName,
          input: auditInput,
          output: snapshot.screen,
          durationMs: Date.now() - start,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  screen: snapshot.screen,
                  cursor: { x: snapshot.cursorX, y: snapshot.cursorY },
                  cols: snapshot.cols,
                  rows: snapshot.rows,
                  alive: session.isAlive(),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to interact with terminal");
        AuditLogger.log({
          tool: "terminal",
          connection: connectionName,
          input: auditInput,
          durationMs: Date.now() - start,
          error: { code: toolError.code, message: toolError.message },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  code: toolError.code,
                  message: toolError.message,
                  retriable: toolError.retriable,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "terminal_resize",
    {
      description:
        "Resize the interactive terminal PTY. Some TUI/bastion portals require a large window to render their menu; call this if the screen shows a 'window too small' warning.",
      inputSchema: {
        cols: z.number().describe("New terminal width in columns (e.g. 200)."),
        rows: z.number().describe("New terminal height in rows (e.g. 50)."),
        connectionName: z.string().optional().describe(CONNECTION_NAME_DESC),
      },
    },
    async ({ cols, rows, connectionName }) => {
      const start = Date.now();
      const auditInput = { cols, rows };
      try {
        const session = await sshManager.getTerminalSession(connectionName);
        session.resize(cols, rows);
        // Give the remote TUI a moment to redraw at the new size.
        const snapshot = await session.readScreen();
        AuditLogger.log({
          tool: "terminal_resize",
          connection: connectionName,
          input: auditInput,
          output: snapshot.screen,
          durationMs: Date.now() - start,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  resized: { cols, rows },
                  screen: snapshot.screen,
                  cursor: { x: snapshot.cursorX, y: snapshot.cursorY },
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to resize terminal");
        AuditLogger.log({
          tool: "terminal_resize",
          connection: connectionName,
          input: auditInput,
          durationMs: Date.now() - start,
          error: { code: toolError.code, message: toolError.message },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  code: toolError.code,
                  message: toolError.message,
                  retriable: toolError.retriable,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
