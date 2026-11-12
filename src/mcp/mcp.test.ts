import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from '../storage/index.js';
import { RunlogMcpTools } from './tools.js';

describe('RunlogMcpTools', () => {
  let tempDir: string;
  let storage: StorageManager;
  let tools: RunlogMcpTools;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agentrunlog_mcp_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new StorageManager(tempDir);
    tools = new RunlogMcpTools(storage);

    // Seed test data
    storage.wiki.saveDecision({
      id: 'DEC-001',
      title: 'Adopt Stdio for MCP Transport',
      status: 'active',
      decidedBy: 'Turgay',
      author: 'team',
      context: 'Agents need universal IPC without opening localhost TCP ports.',
      choice: 'Standard Input/Output (stdio) transport via MCP SDK.',
      supersedes: [],
      supersededBy: null,
      affectsModules: ['src/mcp/**'],
      evidence: { sessionId: 'sess_1', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    storage.wiki.saveDecision({
      id: 'DEC-002',
      title: 'Legacy HTTP SSE Transport',
      status: 'superseded',
      decidedBy: 'Turgay',
      author: 'team',
      context: 'Initial test using Server-Sent Events.',
      choice: 'Use SSE over port 3000.',
      supersedes: [],
      supersededBy: 'DEC-001',
      affectsModules: ['src/mcp/**'],
      evidence: { sessionId: 'sess_0', timestamp: new Date().toISOString() },
      confidence: 'medium',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    storage.wiki.saveDeadEnd({
      id: 'DEAD-001',
      title: 'Synchronous Subprocess LLM in Hook',
      rootCauseType: 'architectural',
      approach: 'Run Ollama CLI inside preToolUse hook',
      whyFailed: 'Added 850ms latency to every file edit, freezing cursor IDE',
      retryConditions: 'Only viable if sub-5ms local embedded model is available',
      affectsModules: ['src/hooks/**'],
      evidence: { sessionId: 'sess_2', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
    });

    storage.wiki.saveRCA({
      id: 'RCA-001',
      title: 'Unsanitized Token in Session Log',
      incident: 'GitHub PAT appeared in raw jsonl stream',
      rootCause: 'Regex did not cover github_pat_ prefix',
      resolution: 'Updated DEFAULT_RULES with pattern matching github_pat_',
      preventativeActions: ['Added vitest regression case for github_pat_'],
      affectsFiles: ['src/sanitizer/index.ts'],
      evidence: { sessionId: 'sess_3', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('searches runlog and excludes superseded decisions by default (FR-07)', () => {
    const res = tools.searchRunlog({ query: 'transport' });
    expect(res.total).toBe(1);
    expect(res.results[0].id).toBe('DEC-001');
    expect(res.results.find((r) => r.id === 'DEC-002')).toBeUndefined();

    // With includeSuperseded = true
    const resWithSuperseded = tools.searchRunlog({ query: 'transport', includeSuperseded: true });
    expect(resWithSuperseded.total).toBe(2);
  });

  it('retrieves single decision details by ID', () => {
    const dec = tools.getDecision('DEC-001');
    expect(dec).not.toBeNull();
    expect(dec?.title).toBe('Adopt Stdio for MCP Transport');
    expect(dec?.choice).toContain('Standard Input/Output');
  });

  it('retrieves RCA details by ID', () => {
    const rca = tools.getRCA('RCA-001');
    expect(rca).not.toBeNull();
    expect(rca?.rootCause).toContain('github_pat_');
  });

  it('checks dead ends and emits soft guardrail warnings (FR-18, FR-20)', () => {
    const result = tools.checkDeadEnds({ approach: 'Run Ollama CLI in preToolUse hook' });
    expect(result.hasKnownFailures).toBe(true);
    expect(result.deadEnds.length).toBe(1);
    expect(result.warningMessage).toContain('⚠️ WARNING: 1 prior failed attempt');
    expect(result.warningMessage).toContain('Only viable if sub-5ms local embedded model is available');

    // Safe approach without recorded failure
    const safe = tools.checkDeadEnds({ approach: 'Use simple grep command' });
    expect(safe.hasKnownFailures).toBe(false);
    expect(safe.deadEnds.length).toBe(0);
  });

  it('records live decisions, dead ends, and RCAs via MCP write tools', () => {
    const newDec = tools.recordDecision({
      title: 'Use Vitest over Jest',
      context: 'ESM native support needed without complex babel configs',
      choice: 'Adopt Vitest for unit and E2E testing',
      supersedes: ['DEC-001'],
      affectsModules: ['src/tests/**'],
    });
    expect(newDec.id).toBe('DEC-003');
    expect(newDec.status).toBe('active');

    // DEC-001 should now be superseded!
    const oldDec = tools.getDecision('DEC-001');
    expect(oldDec?.status).toBe('superseded');
    expect(oldDec?.supersededBy).toBe('DEC-003');

    const newDeadEnd = tools.recordDeadEnd({
      title: 'Avoid Sync Hook Calls',
      approach: 'Blocking HTTP call inside PreToolUse',
      whyFailed: 'Stalled terminal input by 400ms',
      retryConditions: 'Never retry synchronously; use detached worker',
    });
    expect(newDeadEnd.id).toBe('DEAD-002');

    const newRca = tools.recordRCA({
      title: 'Cache Miss on Startup',
      incident: 'PreInvocation returned empty on first boot',
      rootCause: 'active_context.json omitted recent RCAs',
      resolution: 'Included recentRCAs in ActiveContextCacheSchema',
    });
    expect(newRca.id).toBe('RCA-002');
  });
});

describe('MCP record ids and input hygiene (R9)', () => {
  it('never reuses an id after gaps and redacts secrets in inputs', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StorageManager } = await import('../storage/index.js');
    const { RunlogMcpTools, nextRecordId } = await import('./tools.js');
    expect(nextRecordId('DEC', ['DEC-001', 'DEC-007', 'DEC-a1b2c3'])).toBe('DEC-008');
    const st = new StorageManager(mkdtempSync(join(tmpdir(), 'runlog_mcp_')));
    const tools = new RunlogMcpTools(st);
    const a = tools.recordDecision({ title: 'a', context: 'c', choice: 'use postgres://u:supersecret99@h:5432/d' });
    const b = tools.recordDecision({ title: 'b', context: 'c', choice: 'x' });
    expect(a.id).not.toBe(b.id);
    expect(a.choice).not.toContain('supersecret99');
  });
});
