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

  it('Antigravity hooks.json uses named group, flat/nested shapes, merges, and is idempotent', async () => {
    const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StorageManager } = await import('../storage/index.js');
    const { HookManager } = await import('./index.js');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_ag_'));
    mkdirSync(join(dir, '.agents'), { recursive: true });
    const file = join(dir, '.agents', 'hooks.json');
    writeFileSync(file, JSON.stringify({ mine: { Stop: [{ type: 'command', command: 'echo mine' }] } }));
    const hm = new HookManager(new StorageManager(dir));
    hm.antigravity.install(dir);
    hm.antigravity.install(dir);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.mine.Stop[0].command).toBe('echo mine');
    const g = cfg.agentrunlog;
    expect(g.SessionStart).toHaveLength(1);
    expect(g.SessionStart[0].type).toBe('command');
    expect(g.SessionStart[0].command).toContain('hook antigravity session-start');
    expect(g.PostToolUse[0].matcher).toBe('*');
    expect(g.PostToolUse[0].hooks[0].command).toContain('post-tool-use');
    expect(g.PreToolUse).toBeUndefined();
    expect(g.Stop[0].hooks).toBeUndefined();
  });

  it('formatHookOutput speaks each platform dialect', async () => {
    const { formatHookOutput } = await import('./light.js');
    expect(formatHookOutput('claude', 'session-start', 'ctx')).toBe('ctx');
    expect(JSON.parse(formatHookOutput('cursor', 'session-start', 'ctx')!)).toEqual({ additional_context: 'ctx' });
    expect(JSON.parse(formatHookOutput('antigravity', 'session-start', 'ctx')!).injectSteps[0].systemMessage.systemMessage).toBe('ctx');
    expect(JSON.parse(formatHookOutput('antigravity', 'stop', null)!).decision).toBe('allow');
    expect(JSON.parse(formatHookOutput('antigravity', 'pre-invocation', null)!)).toEqual({ injectSteps: [] });
  });
});

describe('Large hook payloads and disk usage', () => {
  it('captures a >8MB event completely (no cap, no loss) and reports disk usage', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const { storageUsage } = await import('../storage/usage.js');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_big_'));
    writeFileSync(join(dir, 'package.json'), '{"name":"big"}');
    const big = 'x'.repeat(10 * 1024 * 1024);
    const payload = JSON.stringify({ session_id: 'big1', cwd: dir, prompt: big });
    const r = spawnSync('node', [resolve('bundle/hook.mjs'), 'claude', 'prompt-submit'], { input: payload, cwd: dir, env: { ...process.env, AGENTRUNLOG_INTERNAL: '', AGENTRUNLOG_NO_WORKER: '1' } });
    expect(r.status).toBe(0);
    const raw = join(dir, '.agentrunlog', 'raw');
    const f = readdirSync(raw).find((n) => n.includes('big1'));
    expect(f).toBeTruthy();
    expect(readFileSync(join(raw, f!), 'utf8').length).toBeGreaterThan(10 * 1024 * 1024);
    const u = storageUsage(join(dir, '.agentrunlog'));
    expect(u.total).toBeGreaterThan(10 * 1024 * 1024);
    expect(u.entries.find((e) => e.name === 'raw/')!.bytes).toBeGreaterThan(10 * 1024 * 1024);
  }, 30000);
});

describe('Concurrent sessions and lifecycle events (real hook bundle)', () => {
  it('parallel hooks from two sessions never corrupt or lose events; session-end/pre-compact compile in background', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, writeFileSync, readFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join, resolve } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_conc_'));
    writeFileSync(join(dir, 'package.json'), '{"name":"conc"}');
    // pre-bootstrap so workers do not race the test
    const bootstrapDir = join(dir, '.agentrunlog', 'cache');
    (await import('node:fs')).mkdirSync(bootstrapDir, { recursive: true });
    writeFileSync(join(bootstrapDir, 'bootstrap.done'), 'x');
    writeFileSync(join(bootstrapDir, 'history_sync.json'), JSON.stringify({ at: Date.now(), version: 99 }));

    const run = (event: string, payload: object) =>
      new Promise<number>((res) => {
        const p = spawn('node', [resolve('bundle/hook.mjs'), 'claude', event], { cwd: dir, env: { ...process.env, AGENTRUNLOG_INTERNAL: '' }, stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('close', (c) => res(c ?? -1));
        p.stdin.end(JSON.stringify({ cwd: dir, ...payload }));
      });

    const jobs: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      for (const sid of ['sessA', 'sessB']) {
        const text = i % 7 === 0 ? 'x'.repeat(300_000) : `message ${i} from ${sid}`;
        jobs.push(run('prompt-submit', { session_id: sid, prompt: text }));
      }
    }
    const codes = await Promise.all(jobs);
    expect(codes.every((c) => c === 0)).toBe(true);

    for (const sid of ['sessA', 'sessB']) {
      const lines = readFileSync(join(dir, '.agentrunlog', 'raw', `session-${sid}.jsonl`), 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBe(20); // none lost
      for (const l of lines) JSON.parse(l); // none corrupted/interleaved
    }

    await run('pre-compact', { session_id: 'sessA' });
    await run('session-end', { session_id: 'sessB' });
    const wiki = join(dir, '.agentrunlog', 'wiki', 'runs');
    for (let i = 0; i < 100 && !(existsSync(join(wiki, 'sessB.md')) && existsSync(join(wiki, 'sessA.md'))); i++) await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(wiki, 'sessB.md'))).toBe(true);
    expect(existsSync(join(wiki, 'sessA.md'))).toBe(true);
  }, 60000);
});

describe('Failed tool calls (Claude PostToolUseFailure)', () => {
  it('maps post-tool-use-failure to post_tool_use and the journey records it as a failed command', async () => {
    const { mapEvent } = await import('./light.js');
    expect(mapEvent('post-tool-use-failure')).toBe('post_tool_use');
    const { buildSessionJourney } = await import('../compiler/journey.js');
    const md = buildSessionJourney([
      { sessionId: 's', platform: 'claude_code', eventType: 'post_tool_use', timestamp: '2026-01-01T00:00:00Z', payload: { tool_name: 'Bash', tool_input: { command: 'ls /nope' }, error: 'Exit code 2\nls: /nope: No such file or directory' } },
    ] as any);
    expect(md).toMatch(/failed|✗/i);
    expect(md).toContain('ls /nope');
  });
});
