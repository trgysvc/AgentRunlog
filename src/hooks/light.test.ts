import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLightHook, mapEvent } from './light.js';
import { acquireLock, isLockFresh } from '../storage/lock.js';
import { formatPushText } from '../storage/push-format.js';

describe('light hook core', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runlog_light_'));
    mkdirSync(join(root, 'cache'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const base = () => ({ platform: 'claude', payloadParsed: true, storageRoot: root });

  it('maps stop to a turn boundary, never to session_end', () => {
    expect(mapEvent('stop')).toBe('agent_response');
    expect(mapEvent('session-end')).toBe('session_end');
    expect(mapEvent('pre-compact')).toBe('pre_compact');
  });

  it('redacts secrets before writing and does not invent a session for junk input', () => {
    runLightHook({ ...base(), event: 'prompt-submit', sessionId: 's1', payload: { text: 'sk-ant-abcdefghijklmnopqrstuvwxyz123' } });
    const line = readFileSync(join(root, 'raw', 'session-s1.jsonl'), 'utf8');
    expect(line).not.toContain('abcdefghijklmnopqrstuvwxyz123');
    runLightHook({ ...base(), event: 'prompt-submit', payload: {}, payloadParsed: false });
    expect(readdirSync(join(root, 'raw'))).toEqual(['session-s1.jsonl']);
  });

  it('pushes only from the pre-compiled cache and respects the char budget', () => {
    writeFileSync(
      join(root, 'cache', 'active_context.json'),
      JSON.stringify({ activeDecisions: Array.from({ length: 200 }, (_, i) => ({ id: `DEC-${i}`, title: 't'.repeat(40), choice: 'c'.repeat(40) })) })
    );
    const out = runLightHook({ ...base(), event: 'session-start', sessionId: 's2', payload: {} })!;
    expect(out).toContain('DEC-0');
    expect(out.length).toBeLessThanOrEqual(3200);
    expect(formatPushText(null)).toBeNull();
  });

  it('honours the recursion shield', () => {
    const out = runLightHook({ ...base(), event: 'session-start', sessionId: 's3', payload: {}, env: { AGENTRUNLOG_INTERNAL: '1' } });
    expect(out).toBeNull();
    expect(existsSync(join(root, 'raw'))).toBe(false);
  });

  it('counts prompt turns for the compile threshold', () => {
    writeFileSync(join(root, 'cache', 'bootstrap.done'), 'x');
    for (let i = 0; i < 3; i++) runLightHook({ ...base(), event: 'prompt-submit', sessionId: 's4', payload: {}, cliPath: join(root, 'missing.mjs'), env: { AGENTRUNLOG_NOSPAWN: '1' } });
    expect(JSON.parse(readFileSync(join(root, 'cache', 'pending.json'), 'utf8')).turns).toBe(3);
  });

  it('exclusive lock blocks a second worker and is released', () => {
    const lock = join(root, 'cache', 'compile.lock');
    const release = acquireLock(lock)!;
    expect(release).toBeTruthy();
    expect(isLockFresh(lock)).toBe(true);
    expect(acquireLock(lock)).toBeNull();
    release();
    expect(acquireLock(lock)).toBeTruthy();
  });
});
