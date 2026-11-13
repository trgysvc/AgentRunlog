import { describe, it, expect } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from './storage/index.js';
import { RunlogMcpTools } from './mcp/tools.js';
import { WikiReindexer } from './compiler/reindex.js';
import { runLightHook } from './hooks/light.js';

const tmp = () => join(tmpdir(), `runlog_nfr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);

describe('NFR-10: MCP records survive a deleted wiki', () => {
  it('reindex replays the journal', async () => {
    const dir = tmp();
    const st = new StorageManager(dir);
    const tools = new RunlogMcpTools(st);
    const d = tools.recordDecision({ title: 'Use X', context: 'c', choice: 'X', projectRoot: dir });
    const de = tools.recordDeadEnd({ title: 'Bad', approach: 'a', whyFailed: 'architecture mismatch', retryConditions: 'never', projectRoot: dir });
    rmSync(st.paths.wiki, { recursive: true, force: true });
    const st2 = new StorageManager(dir);
    await new WikiReindexer(st2).reindex();
    expect(st2.wiki.listDecisions().map((x) => x.id)).toContain(d.id);
    expect(st2.wiki.listDeadEnds().map((x) => x.id)).toContain(de.id);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('FR-05: record_dead_end rejects transient failures', () => {
  it('throws for 503 / timeout', () => {
    const dir = tmp();
    const tools = new RunlogMcpTools(new StorageManager(dir));
    expect(() => tools.recordDeadEnd({ title: 't', approach: 'a', whyFailed: '503 service unavailable', retryConditions: 'x', projectRoot: dir })).toThrow(/Not a dead end/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('NFR-03: opt-out and exclusion patterns', () => {
  const run = (root: string, payload: any) =>
    runLightHook({ platform: 'claude', event: 'post-tool-use', payload: { session_id: 's1', ...payload }, payloadParsed: true, storageRoot: root, env: {} });
  const rawFile = (root: string) => join(root, 'raw', 'session-s1.jsonl');

  it('excludePatterns drops matching events only', () => {
    const root = join(tmp(), '.agentrunlog');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ privacy: { excludePatterns: ['**/secrets/**', '.env*'] } }));
    run(root, { tool_name: 'Read', tool_input: { file_path: '/p/secrets/key.txt' } });
    run(root, { tool_name: 'Read', tool_input: { file_path: '/p/.env.local' } });
    expect(existsSync(rawFile(root))).toBe(false);
    run(root, { tool_name: 'Read', tool_input: { file_path: '/p/src/a.ts' } });
    expect(readFileSync(rawFile(root), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('paused flag and privacy.enabled=false record nothing', () => {
    const root = join(tmp(), '.agentrunlog');
    mkdirSync(join(root, 'cache'), { recursive: true });
    writeFileSync(join(root, 'cache', 'paused'), 'x');
    run(root, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(existsSync(rawFile(root))).toBe(false);
    rmSync(join(root, 'cache', 'paused'));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ privacy: { enabled: false } }));
    run(root, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(existsSync(rawFile(root))).toBe(false);
  });
});

import { buildImpactReport } from './compiler/report.js';
describe('impact report', () => {
  it('counts sessions, injections and repeated failures', () => {
    const dir = tmp();
    const st = new StorageManager(dir);
    mkdirSync(st.paths.raw, { recursive: true });
    const ev = (t: string, p: any = {}) => JSON.stringify({ sessionId: 'x', platform: 'claude_code', eventType: t, timestamp: 'now', payload: p }) + '\n';
    for (const s of ['a', 'b']) {
      writeFileSync(join(st.paths.raw, `session-${s}.jsonl`), ev('session_start') + ev('post_tool_use', { error: 'boom', tool_input: { command: 'make x' } }));
    }
    const r = buildImpactReport(st);
    expect(r.sessions).toBe(2);
    expect(r.injections).toBe(2);
    expect(r.repeatedFailures[0]).toEqual({ command: 'make x', sessions: 2 });
    rmSync(dir, { recursive: true, force: true });
  });
});
