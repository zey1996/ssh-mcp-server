import fs from "fs";
import path from "path";

/**
 * Audit log entry. One JSON object per line (JSONL) so logs are easy to parse
 * with standard tools (grep, jq, etc.).
 */
export interface AuditEntry {
	/** ISO timestamp of the operation. Auto-filled if omitted. */
	timestamp?: string;
	/** MCP tool name, e.g. "execute-command", "terminal". */
	tool: string;
	/** SSH connection name, if applicable. */
	connection?: string;
	/** Sanitized input parameters (credentials never appear here). */
	input?: Record<string, unknown>;
	/** Result summary (command stdout / terminal screen, possibly truncated). */
	output?: string;
	/** Operation duration in milliseconds. */
	durationMs?: number;
	/** Error details, if the operation failed. */
	error?: { code: string; message: string };
}

/** Default cap on recorded output length (keeps audit files manageable). */
const DEFAULT_MAX_OUTPUT_CHARS = 8000;

/** Truncate a string to `max` chars, appending a marker when truncated. */
function truncate(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max)}\n...[truncated ${value.length - max} chars]`;
}

/**
 * File-backed audit logger. Writes JSONL audit entries to a configured file.
 *
 * - Disabled by default: only writes when a path is configured via
 *   `--audit-log <path>` or the `SSH_MCP_AUDIT_LOG` environment variable.
 * - Completely independent from the stderr diagnostic `Logger`; enabling the
 *   audit log does not change any existing logging behavior.
 * - Credentials (passwords, private keys, passphrases) are never recorded.
 */
class AuditLoggerImpl {
	private stream: fs.WriteStream | null = null;
	private filePath: string | null = null;
	private maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS;

	/**
	 * Configure the audit log destination. Call once at startup. If no path is
	 * provided (and no env var is set), the audit logger stays disabled and
	 * `log()` is a no-op — preserving the original behavior.
	 */
	configure(filePath?: string): void {
		const resolved = filePath || process.env.SSH_MCP_AUDIT_LOG;
		if (!resolved) {
			this.stream = null;
			this.filePath = null;
			return;
		}

		try {
			const absolute = path.resolve(resolved);
			const dir = path.dirname(absolute);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			// Append mode so restarts keep history. ResizableWriteStream.
			this.stream = fs.createWriteStream(absolute, { flags: "a" });
			this.filePath = absolute;
			this.stream.on("error", (err: Error) => {
				process.stderr.write(
					`[audit] audit log write failed for ${absolute}: ${err.message}\n`,
				);
				this.stream = null;
			});
			this.log({
				timestamp: new Date().toISOString(),
				tool: "__audit_start__",
				input: { path: absolute, maxOutputChars: this.maxOutputChars },
			});
		} catch (err) {
			process.stderr.write(
				`[audit] failed to open audit log ${resolved}: ${(err as Error).message}\n`,
			);
			this.stream = null;
			this.filePath = null;
		}
	}

	/** Whether audit logging is currently enabled. */
	isEnabled(): boolean {
		return this.stream !== null;
	}

	/** The configured audit file path, if any. */
	getFilePath(): string | null {
		return this.filePath;
	}

	/**
	 * Record an audit entry. No-op when the audit log is not configured.
	 * `output` is truncated to `maxOutputChars` to keep files manageable.
	 */
	log(entry: AuditEntry): void {
		if (!this.stream) {
			return;
		}
		if (!entry.timestamp) {
			entry.timestamp = new Date().toISOString();
		}
		if (entry.output && entry.output.length > this.maxOutputChars) {
			entry.output = truncate(entry.output, this.maxOutputChars);
		}
		try {
			this.stream.write(JSON.stringify(entry) + "\n");
		} catch {
			// Swallow write errors; audit logging must never break tool execution.
		}
	}

	/** Flush and close the audit log. Safe to call at shutdown. Returns a
	 * promise that resolves once buffered writes are flushed, so callers that
	 * need to read the file immediately can await it. */
	close(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.stream) {
				resolve();
				return;
			}
			const stream = this.stream;
			this.stream = null;
			try {
				stream.end(() => resolve());
			} catch {
				resolve();
			}
		});
	}
}

/** Singleton audit logger instance. */
export const AuditLogger = new AuditLoggerImpl();
