import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";
import { AuditLogger } from "../utils/audit-logger.js";

/**
 * Register file download tool
 */
export function registerDownloadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "download",
    {
      description: "Download file from connected server",
      inputSchema: {
        remotePath: z.string().describe("Remote path"),
        localPath: z.string().describe("Local path"),
        connectionName: z.string().optional().describe("SSH connection name (optional, default is 'default')"),
      },
    },
    async ({ remotePath, localPath, connectionName }) => {
      const start = Date.now();
      const auditInput = { remotePath, localPath };
      try {
        const result = await sshManager.download(remotePath, localPath, connectionName);
        AuditLogger.log({
          tool: "download",
          connection: connectionName,
          input: auditInput,
          output: result,
          durationMs: Date.now() - start,
        });
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");
        Logger.handleError(toolError, "Failed to download file");
        AuditLogger.log({
          tool: "download",
          connection: connectionName,
          input: auditInput,
          durationMs: Date.now() - start,
          error: { code: toolError.code, message: toolError.message },
        });
        return {
          content: [{
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
          }],
          isError: true,
        };
      }
    }
  );
}
