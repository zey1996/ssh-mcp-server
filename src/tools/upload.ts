import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";
import { AuditLogger } from "../utils/audit-logger.js";

/**
 * Register file upload tool
 */
export function registerUploadTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "upload",
    {
      description: "Upload file to connected server",
      inputSchema: {
        localPath: z.string().describe("Local path"),
        remotePath: z.string().describe("Remote path"),
        connectionName: z.string().optional().describe("SSH connection name (optional, default is 'default')"),
      },
    },
    async ({ localPath, remotePath, connectionName }) => {
      const start = Date.now();
      const auditInput = { localPath, remotePath };
      try {
        const result = await sshManager.upload(localPath, remotePath, connectionName);
        AuditLogger.log({
          tool: "upload",
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
        Logger.handleError(toolError, "Failed to upload file");
        AuditLogger.log({
          tool: "upload",
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
