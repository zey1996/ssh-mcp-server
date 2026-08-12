import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuditLogger } from '../build/utils/audit-logger.js';

describe('AuditLogger', () => {
  let tmpFile;
  let savedEnv;

  before(() => {
    savedEnv = process.env.SSH_MCP_AUDIT_LOG;
    delete process.env.SSH_MCP_AUDIT_LOG;
    tmpFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')),
      'audit.jsonl',
    );
  });

  after(async () => {
    await AuditLogger.close();
    if (savedEnv !== undefined) {
      process.env.SSH_MCP_AUDIT_LOG = savedEnv;
    } else {
      delete process.env.SSH_MCP_AUDIT_LOG;
    }
  });

  it('默认未配置时不启用, log 是 no-op 且不创建文件', () => {
    AuditLogger.close();
    AuditLogger.configure();
    assert.strictEqual(AuditLogger.isEnabled(), false);
    AuditLogger.log({ tool: 'execute-command', input: { cmdString: 'ls' } });
    // 未配置时不应该有任何文件路径
    assert.strictEqual(AuditLogger.getFilePath(), null);
  });

  it('配置路径后启用, 记录为 JSONL 每行一条', async () => {
    AuditLogger.configure(tmpFile);
    assert.strictEqual(AuditLogger.isEnabled(), true);
    assert.strictEqual(AuditLogger.getFilePath(), tmpFile);

    AuditLogger.log({
      tool: 'execute-command',
      connection: 'default',
      input: { cmdString: 'whoami' },
      output: 'deployer',
      durationMs: 12,
    });
    AuditLogger.log({
      tool: 'terminal',
      connection: 'default',
      input: { text: '1', keys: ['Enter'] },
      output: 'menu screen',
      durationMs: 5,
    });

    // flush 写流
    await AuditLogger.close();

    const content = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
    let start, entries;
    try {
      start = JSON.parse(content[0]);
      entries = content.slice(1).map((line) => JSON.parse(line));
    } catch (e) {
      assert.fail(`audit log is not valid JSONL: ${e.message}`);
    }
    assert.strictEqual(start.tool, '__audit_start__');
    assert.strictEqual(start.input.path, tmpFile);
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(entries[0].tool, 'execute-command');
    assert.strictEqual(entries[0].input.cmdString, 'whoami');
    assert.strictEqual(entries[0].output, 'deployer');
    assert.ok(entries[0].timestamp);
    assert.strictEqual(entries[1].tool, 'terminal');
    assert.deepStrictEqual(entries[1].input.keys, ['Enter']);
  });

  it('环境变量 SSH_MCP_AUDIT_LOG 也能启用', async () => {
    const envFile = path.join(path.dirname(tmpFile), 'env.jsonl');
    process.env.SSH_MCP_AUDIT_LOG = envFile;
    AuditLogger.configure();
    assert.strictEqual(AuditLogger.isEnabled(), true);
    assert.strictEqual(AuditLogger.getFilePath(), envFile);
    await AuditLogger.close();
    delete process.env.SSH_MCP_AUDIT_LOG;
  });

  it('超长 output 会被截断', async () => {
    const truncFile = path.join(path.dirname(tmpFile), 'trunc.jsonl');
    AuditLogger.configure(truncFile);
    const longOutput = 'x'.repeat(20000);
    AuditLogger.log({ tool: 'terminal', output: longOutput });
    await AuditLogger.close();
    const lines = fs.readFileSync(truncFile, 'utf8').trim().split('\n');
    let entry;
    try {
      entry = JSON.parse(lines[lines.length - 1]);
    } catch (e) {
      assert.fail(`not JSONL: ${e.message}`);
    }
    assert.ok(entry.output.length < 20000);
    assert.ok(entry.output.includes('truncated'));
  });
});
