import { describe, it, expect } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { StorageManager } from './storage/index.js';
import { TranscriptExtractor } from './compiler/extractor.js';
import { WikiLinter } from './compiler/linter.js';
import { runLightHook, formatHookOutput } from './hooks/light.js';
import { formatPushText } from './storage/push-format.js';
import { buildSessionJourney } from './compiler/journey.js';

const tmp = () => join(tmpdir(), `runlog_feat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
let t = 0;
const ev = (sessionId: string, eventType: string, payload: any) => ({
  sessionId,
  platform: 'claude_code',
  eventType,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString(),
  payload,
});
const bash = (command: string, exitCode = 0, error?: string) =>
  ev('s1', 'post_tool_use', { tool_name: 'Bash', tool_input: { command }, ...(exitCode ? { exitCode, error: error || `exit ${exitCode}` } : {}) });

function writeRaw(dir: string, events: any[]) {
  const st = new StorageManager(dir);
  const f = join(st.paths.raw, 'session-s1.jsonl');
  mkdirSync(st.paths.raw, { recursive: true });
  writeFileSync(f, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { st, f };
}

describe('handoff, verified commands, claim check', () => {
  it('open work -> in_progress task, handoff + verified lines in push, unverified claim flagged', async () => {
    const dir = tmp();
    const { st, f } = writeRaw(dir, [
      ev('s1', 'session_start', {}),
      ev('s1', 'prompt_submit', { prompt: 'fix the parser' }),
      bash('npm run build', 0),
      bash('npm test', 1, 'AssertionError: expected 1 to be 2'),
      ev('s1', 'agent_response', { last_assistant_message: 'Done, all tests pass now.' }),
    ]);
    await new TranscriptExtractor(st).extractAndCompile(f);
    expect(st.wiki.listTasks()[0].status).toBe('in_progress');
    const cache = st.cache.getActiveContext()!;
    expect(cache.lastSession?.text).toMatch(/OPEN/);
    expect(cache.verified?.join('\n')).toMatch(/build: `npm run build`/);
    const push = formatPushText(cache)!;
    expect(push).toMatch(/Last session/);
    expect(push).toMatch(/Verified commands/);
    expect(cache.estimatedTokens).toBeLessThanOrEqual(800);
    const journey = buildSessionJourney(new TranscriptExtractor(st).readSessionEvents(f))!;
    expect(journey).toMatch(/Unverified claims/);
    rmSync(dir, { recursive: true, force: true });
  });
  it('handoff exists without any session_end event', async () => {
    const dir = tmp();
    const { st, f } = writeRaw(dir, [ev('s1', 'prompt_submit', { prompt: 'add feature' }), bash('npm test', 0)]);
    await new TranscriptExtractor(st).extractAndCompile(f);
    expect(st.cache.getActiveContext()?.lastSession?.text).toMatch(/No open failures/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('code sync', () => {
  it('records whose cited files are all gone are lint-flagged and not pushed', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'alive.ts'), 'x');
    const st = new StorageManager(dir);
    const base = { context: 'c', alternatives: [], consequences: '', supersedes: [], status: 'active', confidence: 'high', decidedBy: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), evidence: { sessionId: 'live_1', lineNumber: 1, turnIndex: 1, hash: 'a', timestamp: new Date().toISOString() } } as any;
    st.wiki.saveDecision({ ...base, id: 'DEC-ALIVE', title: 'alive', choice: 'keep', affectsModules: ['src/alive.ts'] });
    st.wiki.saveDecision({ ...base, id: 'DEC-GONE', title: 'gone', choice: 'old', affectsModules: ['src/removed.ts'] });
    new TranscriptExtractor(st).refreshActiveContextCache();
    const ids = st.cache.getActiveContext()!.activeDecisions.map((d) => d.id);
    expect(ids).toContain('DEC-ALIVE');
    expect(ids).not.toContain('DEC-GONE');
    expect(new WikiLinter(st, dir).lint().issues.some((i) => i.code === 'STALE_CODE_REF' && i.recordId === 'DEC-GONE')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('repeated-failure guardrail', () => {
  it('injects the known fix on the 2nd failure only, as Claude additionalContext', () => {
    const dir = tmp();
    const root = join(dir, '.agentrunlog');
    mkdirSync(join(root, 'cache'), { recursive: true });
    writeFileSync(join(root, 'cache', 'guard_index.json'), JSON.stringify([{ id: 'RCA-1', kind: 'rca', key: 'npm test', text: '[RCA-1] Known fix: run npm ci first' }]));
    const fail = () =>
      runLightHook({ platform: 'claude', event: 'post-tool-use-failure', payload: { session_id: 'g1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'boom' }, payloadParsed: true, storageRoot: root, env: {} });
    expect(fail()).toBeNull();
    const second = fail();
    expect(second).toMatch(/Known fix: run npm ci first/);
    expect(fail()).toBeNull();
    const out = JSON.parse(formatHookOutput('claude', 'post-tool-use-failure', second)!);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/RCA-1/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('git link', () => {
  it('tasks and the journey page carry commits made during the session', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
    g('init', '-q');
    writeFileSync(join(dir, 'a.txt'), '1');
    g('add', '.');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work in session');
    const now = Date.now();
    const evs = [
      { ...ev('s1', 'prompt_submit', { prompt: 'do work' }), timestamp: new Date(now - 60_000).toISOString() },
      { ...bash('npm test', 0), timestamp: new Date(now + 60_000).toISOString() },
    ];
    const { st, f } = writeRaw(dir, evs);
    await new TranscriptExtractor(st).extractAndCompile(f);
    expect(st.wiki.listTasks()[0].commits?.length).toBe(1);
    expect(readFileSync(join(st.paths.runs, 's1.md'), 'utf8')).toMatch(/work in session/);
    rmSync(dir, { recursive: true, force: true });
  });
  it('skips silently without a repo', async () => {
    const dir = tmp();
    const { st, f } = writeRaw(dir, [ev('s1', 'prompt_submit', { prompt: 'x' })]);
    await new TranscriptExtractor(st).extractAndCompile(f);
    expect(st.wiki.listTasks()[0].commits).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('repeated-failure guard on every platform (documented output shapes)', () => {
  const setup = () => {
    const dir = tmp();
    const root = join(dir, '.agentrunlog');
    mkdirSync(join(root, 'cache'), { recursive: true });
    writeFileSync(join(root, 'cache', 'guard_index.json'), JSON.stringify([{ id: 'RCA-9', kind: 'rca', key: 'npm test', text: '[RCA-9] Known fix: run npm ci' }]));
    return { dir, root };
  };
  const call = (root: string, platform: string, event: string, payload: any) =>
    runLightHook({ platform, event, payload, payloadParsed: true, storageRoot: root, env: {} });

  it('Cursor: postToolUseFailure -> additional_context (error_message, conversation_id)', () => {
    const { dir, root } = setup();
    const pl = { conversation_id: 'c1', hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_input: { command: 'npm test' }, error_message: 'boom', failure_type: 'error' };
    expect(call(root, 'cursor', 'post-tool-use-failure', pl)).toBeNull();
    const g = call(root, 'cursor', 'post-tool-use-failure', pl);
    expect(JSON.parse(formatHookOutput('cursor', 'post-tool-use-failure', g)!).additional_context).toMatch(/RCA-9/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('Codex: PostToolUse after a non-zero Bash exit -> hookSpecificOutput.additionalContext', () => {
    const { dir, root } = setup();
    const pl = { session_id: 'x1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { output: 'Process exited with code 1' } };
    expect(call(root, 'codex', 'post-tool-use', pl)).toBeNull();
    const g = call(root, 'codex', 'post-tool-use', pl);
    const out = JSON.parse(formatHookOutput('codex', 'post-tool-use', g)!);
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toMatch(/RCA-9/);
    // a successful run never counts
    expect(call(root, 'codex', 'post-tool-use', { ...pl, tool_response: { output: 'ok', exit_code: 0 } })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('Antigravity: PostToolUse answers {} and the advisory arrives at the next PreInvocation', () => {
    const { dir, root } = setup();
    const pl = { conversationId: 'a1', toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } }, error: 'exit status 1' };
    expect(call(root, 'antigravity', 'post-tool-use', pl)).toBeNull();
    expect(formatHookOutput('antigravity', 'post-tool-use', call(root, 'antigravity', 'post-tool-use', { ...pl, stepIdx: 2 }))).toBe('{}');
    const pre = call(root, 'antigravity', 'pre-invocation', { conversationId: 'a1' });
    expect(JSON.parse(formatHookOutput('antigravity', 'pre-invocation', pre)!).injectSteps[0].systemMessage.systemMessage).toMatch(/RCA-9/);
    expect(call(root, 'antigravity', 'pre-invocation', { conversationId: 'a1' })).toBeNull(); // delivered once
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('auto lint + opt-in LLM conflict review', () => {
  const mkDec = (id: string, choice: string, mods: string[]) => ({
    id, title: `T ${id}`, status: 'active', decidedBy: 'user', author: 'team', context: 'c', choice, supersedes: [], supersededBy: null,
    affectsModules: mods, evidence: { sessionId: 's', timestamp: '2026-01-01T00:00:00.000Z' }, confidence: 'high',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  it('is off by default; enabled -> pair in push; verdict supersedes; lint.json written on compile', async () => {
    const dir = tmp();
    const st = new StorageManager(dir);
    expect(st.config.llmReview.enabled).toBe(false);
    st.wiki.saveDecision(mkDec('DEC-001', 'Use REST', ['src/api/**']) as any);
    st.wiki.saveDecision(mkDec('DEC-002', 'Use GraphQL', ['src/api/**']) as any);
    new TranscriptExtractor(st).refreshActiveContextCache();
    expect(st.cache.getActiveContext()?.conflictReview).toBeUndefined();
    expect(existsSync(join(st.paths.cache, 'lint.json'))).toBe(true);

    const cfg = JSON.parse(readFileSync(st.paths.config, 'utf8'));
    cfg.llmReview = { enabled: true, consentAt: 'now' };
    writeFileSync(st.paths.config, JSON.stringify(cfg));
    const st2 = new StorageManager(dir);
    new TranscriptExtractor(st2).refreshActiveContextCache();
    const text = formatPushText(st2.cache.getActiveContext() as any)!;
    expect(text).toContain('Decision conflict review');
    expect(text).toContain('review_decision_conflict');

    const { applyReviewVerdict } = await import('./compiler/review.js');
    applyReviewVerdict(st2, 'DEC-001', 'DEC-002', 'conflict', 'DEC-002');
    expect(st2.wiki.listDecisions().find((d) => d.id === 'DEC-001')?.status).toBe('superseded');
    new TranscriptExtractor(st2).refreshActiveContextCache();
    expect(st2.cache.getActiveContext()?.conflictReview).toBeUndefined();
  });
  it('verdict is refused while disabled', async () => {
    const st = new StorageManager(tmp());
    const { applyReviewVerdict } = await import('./compiler/review.js');
    expect(() => applyReviewVerdict(st, 'A', 'B', 'compatible')).toThrow(/disabled/);
  });
});

describe('open-work detection: failures resolved by another route', () => {
  const ev = (i: number, tool: string, p: Record<string, unknown>) =>
    ({ sessionId: 'live_1', platform: 'claude', timestamp: `2026-01-01T00:00:0${i}Z`, eventType: 'post_tool_use', payload: { tool, ...p } }) as any;
  it('closes a failed sed -i once the file is rewritten another way', async () => {
    const { analyzeSession } = await import('./compiler/journey.js');
    const a = analyzeSession([
      ev(1, 'Bash', { command: "sed -i 's/a/b/' x.ts", error: 'sed: bad' }),
      ev(2, 'Bash', { command: "python3 - <<'EOF'\nopen('x.ts','w').write('b')\nEOF", exitCode: 0 }),
    ])!;
    expect(a.open.size).toBe(0);
  });
  it('closes a failed test run after a later passing test run with a different command', async () => {
    const { analyzeSession } = await import('./compiler/journey.js');
    const a = analyzeSession([
      ev(1, 'Bash', { command: 'npm test -- a', exitCode: 1 }),
      ev(2, 'Bash', { command: 'npm test', exitCode: 0 }),
    ])!;
    expect(a.open.size).toBe(0);
  });
  it('keeps an unrelated failure open', async () => {
    const { analyzeSession } = await import('./compiler/journey.js');
    const a = analyzeSession([
      ev(1, 'Bash', { command: 'node deploy.js', exitCode: 2 }),
      ev(2, 'Bash', { command: 'npm test', exitCode: 0 }),
    ])!;
    expect(a.open.size).toBe(1);
  });
});

describe('duplicate hooks and unknown-command imports', () => {
  it('ignores a failure whose command text is unknown (history import placeholder)', async () => {
    const { analyzeSession } = await import('./compiler/journey.js');
    const a = analyzeSession([
      { sessionId: 'import_x', platform: 'antigravity', timestamp: '2026-01-01T00:00:01Z', eventType: 'post_tool_use', payload: { tool: 'terminal_command', unknownCommand: true, exitCode: 1, error: 'Command exited with code 1' } } as any,
    ])!;
    expect(a.open.size).toBe(0);
  });
  it('records an event once when the same hook fires twice', async () => {
    const { runLightHook } = await import('./hooks/light.js');
    const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = join(mkdtempSync(join(tmpdir(), 'dup-')), '.agentrunlog');
    const input = { platform: 'antigravity', event: 'post-tool-use', storageRoot: root, payload: { conversationId: 'c1', toolCall: { name: 'read_file', args: {} }, stepIdx: 4 }, payloadParsed: true } as any;
    runLightHook(input);
    expect(runLightHook(input)).toBeNull();
    const f = readdirSync(join(root, 'raw')).find((x) => x.startsWith('session-'))!;
    expect(readFileSync(join(root, 'raw', f), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
