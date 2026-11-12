import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from '../storage/index.js';
import { HookManager } from './index.js';

describe('Platform Hook Adapters (Claude Code, Antigravity, Cursor, Codex)', () => {
  let tempDir: string;
  let storage: StorageManager;
  let hooks: HookManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agentrunlog_hook_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new StorageManager(tempDir);
    hooks = new HookManager(storage);

    // Seed active context cache for push tests
    storage.cache.setActiveContext({
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeDecisions: [
        {
          id: 'DEC-001',
          title: 'Use Zod for Validation',
          choice: 'Adopt Zod across all schemas',
          affectsModules: ['src/types/**'],
        },
      ],
      recentDeadEnds: [
        {
          id: 'DEAD-001',
          title: 'Direct in-hook LLM',
          approach: 'Run LLM in synchronous hook',
          whyFailed: 'Exceeded 20ms SLA latency',
          retryConditions: 'Do not use unless sub-5ms local engine',
          affectsModules: ['src/hooks/**'],
        },
      ],
      estimatedTokens: 90,
    });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('Claude Code adapter handles session start with fast push injection', () => {
    const push = hooks.claude.handleSessionStart('sess_claude_1');
    expect(push).toContain('### 🧠 AgentRunlog Active Decisions:');
    expect(push).toContain('DEC-001');
    expect(push).toContain('DEAD-001');

    // Verify raw session event was logged atomically
    const rawFile = join(storage.paths.raw, 'session-sess_claude_1.jsonl');
    expect(existsSync(rawFile)).toBe(true);
    const content = readFileSync(rawFile, 'utf8');
    expect(content).toContain('claude_code');
    expect(content).toContain('session_start');
  });

  it('Antigravity adapter pushes context on initial invocation and logs turn', () => {
    const push = hooks.antigravity.handlePreInvocation('sess_antigravity_1', 1);
    expect(push).toContain('### 🧠 AgentRunlog Active Decisions:');
    expect(push).toContain('DEC-001');

    // Second invocation does not re-push context to avoid prompt flooding
    const subsequent = hooks.antigravity.handlePreInvocation('sess_antigravity_1', 2);
    expect(subsequent).toBeNull();
  });

  it('Cursor adapter generates hooks.json and cursor rules fallback instructions (FR-14)', () => {
    const installed = hooks.cursor.install(tempDir);
    expect(existsSync(installed.hooksPath)).toBe(true);
    expect(existsSync(installed.rulesPath)).toBe(true);

    const rulesContent = readFileSync(installed.rulesPath, 'utf8');
    expect(rulesContent).toContain('check_dead_ends');
    expect(rulesContent).toContain('search_runlog');
    expect(rulesContent).toContain('agentrunlog');
  });

  it('Codex CLI adapter generates manifest and handles session start', () => {
    const push = hooks.codex.handleSessionStart('sess_codex_1');
    expect(push).toContain('### 🧠 AgentRunlog Active Decisions:');

    const manifestPath = hooks.codex.install(tempDir);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it('HookManager installs manifests for all 4 platforms', () => {
    const installed = hooks.installAll(tempDir);
    expect(existsSync(installed.claude as string)).toBe(true);
    expect(existsSync(installed.antigravity as string)).toBe(true);
    expect(existsSync(installed.codex as string)).toBe(true);
    expect(existsSync((installed.cursor as any).hooksPath)).toBe(true);
  });

  it('HookRunner dispatches events and respects AGENTRUNLOG_INTERNAL recursion shield', async () => {
    const push = await hooks.runner.runHook({
      platform: 'claude',
      event: 'session-start',
      sessionId: 'sess_runner_test',
    });
    expect(push).toContain('DEC-001');

    // Recursion shield test (NFR-09)
    process.env.AGENTRUNLOG_INTERNAL = '1';
    const blockedPush = await hooks.runner.runHook({
      platform: 'claude',
      event: 'session-start',
      sessionId: 'sess_runner_recursion',
    });
    delete process.env.AGENTRUNLOG_INTERNAL;
    expect(blockedPush).toBeNull();
  });
});

describe('Hook manifests use the nested matcher-group format', () => {
  it('Claude + Codex manifests nest commands under hooks[] and use absolute node paths', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StorageManager } = await import('../storage/index.js');
    const { HookManager } = await import('./index.js');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_manifest_'));
    const hm = new HookManager(new StorageManager(dir));

    // Pre-existing user hook must survive and install must be idempotent
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ theme: 'dark', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } })
    );
    hm.claude.install(dir);
    hm.claude.install(dir);
    const claude = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(claude.theme).toBe('dark');
    expect(claude.hooks.SessionStart).toHaveLength(2);
    expect(claude.hooks.SessionStart[0].hooks[0].command).toBe('echo mine');
    const ours = claude.hooks.SessionStart[1].hooks[0];
    expect(ours.type).toBe('command');
    expect(ours.command).toMatch(/^"\/.*node.*" ".*(bundle\/hook\.mjs|dist\/cli\/index\.js)" hook claude session-start$/);

    const codex = JSON.parse(readFileSync(hm.codex.install(dir), 'utf8'));
    expect(codex.hooks.Stop[0].hooks[0].command).toContain('hook codex stop');
    expect(codex.hooks.Stop[0].type).toBeUndefined();
  });

  it('refuses to overwrite a corrupt settings.json', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StorageManager } = await import('../storage/index.js');
    const { HookManager } = await import('./index.js');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_corrupt_'));
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), '{ not json');
    const hm = new HookManager(new StorageManager(dir));
    expect(() => hm.claude.install(dir)).toThrow(/not valid JSON/);
    expect(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
  });
});
