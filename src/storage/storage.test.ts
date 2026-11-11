import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from './index.js';

describe('StorageManager', () => {
  let tempDir: string;
  let manager: StorageManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agentrunlog_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    manager = new StorageManager(tempDir);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('creates directory hierarchy and default config', () => {
    expect(existsSync(manager.paths.root)).toBe(true);
    expect(existsSync(manager.paths.raw)).toBe(true);
    expect(existsSync(manager.paths.wiki)).toBe(true);
    expect(existsSync(manager.paths.decisions)).toBe(true);
    expect(existsSync(manager.paths.deadEnds)).toBe(true);
    expect(existsSync(manager.paths.config)).toBe(true);
  });

  it('logs raw session events with secrets sanitized', () => {
    const ok = manager.logger.logEvent({
      sessionId: 'sess_123',
      platform: 'claude_code',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: 'Connect to database using postgres://user:secret12345@db:5432/test',
      },
    });

    expect(ok).toBe(true);
    const logFile = join(manager.paths.raw, 'session-sess_123.jsonl');
    expect(existsSync(logFile)).toBe(true);

    const content = readFileSync(logFile, 'utf8');
    expect(content).not.toContain('secret12345');
    expect(content).toContain('[REDACTED:PASSWORD:');
  });

  it('enforces recursion protection (NFR-09)', () => {
    process.env.AGENTRUNLOG_INTERNAL = '1';
    const ok = manager.logger.logEvent({
      sessionId: 'sess_recursion',
      platform: 'antigravity',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: { test: 'nested call' },
    });
    delete process.env.AGENTRUNLOG_INTERNAL;

    expect(ok).toBe(false);
    expect(existsSync(join(manager.paths.raw, 'session-sess_recursion.jsonl'))).toBe(false);
  });

  it('saves and reads typed decisions with supersede graph', () => {
    manager.wiki.saveDecision({
      id: 'DEC-001',
      title: 'Use TypeScript for Core Engine',
      status: 'active',
      decidedBy: 'Turgay',
      author: 'team',
      context: 'Need cross-platform compatibility and typed schemas.',
      choice: 'TypeScript with Node ESM and Zod validation.',
      supersedes: [],
      supersededBy: null,
      affectsModules: ['src/core/**'],
      evidence: {
        sessionId: 'sess_123',
        timestamp: new Date().toISOString(),
      },
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const decisions = manager.wiki.listDecisions();
    expect(decisions.length).toBe(1);
    expect(decisions[0].id).toBe('DEC-001');
    expect(decisions[0].title).toBe('Use TypeScript for Core Engine');
    expect(decisions[0].decidedBy).toBe('Turgay');
  });

  it('saves and formats active context cache for sub-5ms hook push (FR-19)', () => {
    manager.cache.setActiveContext({
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeDecisions: [
        {
          id: 'DEC-001',
          title: 'Use TypeScript',
          choice: 'Adopt TypeScript',
          affectsModules: ['src/**'],
        },
      ],
      recentDeadEnds: [
        {
          id: 'DEAD-001',
          title: 'ChromaDB local binding',
          approach: 'Tried native Chroma Python subprocess',
          whyFailed: 'Crashed on Alpine and caused hook latency > 200ms',
          retryConditions: 'Do not use unless pure JS embedded vector db is available',
          affectsModules: ['src/mcp/**'],
        },
      ],
      estimatedTokens: 120,
    });

    const cached = manager.cache.getActiveContext();
    expect(cached).not.toBeNull();
    expect(cached?.activeDecisions.length).toBe(1);

    const formatted = manager.cache.formatPushInjection(cached);
    expect(formatted).toContain('### 🧠 AgentRunlog Active Decisions:');
    expect(formatted).toContain('DEC-001');
    expect(formatted).toContain('### ⚠️ Known Dead Ends (Do Not Repeat):');
    expect(formatted).toContain('DEAD-001');
  });
});
