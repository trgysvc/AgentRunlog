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
    expect(formatHookOutput('antigravity', 'post-tool-use', call(root, 'antigravity', 'post-tool-use', pl))).toBe('{}');
    const pre = call(root, 'antigravity', 'pre-invocation', { conversationId: 'a1' });
    expect(JSON.parse(formatHookOutput('antigravity', 'pre-invocation', pre)!).injectSteps[0].systemMessage.systemMessage).toMatch(/RCA-9/);
    expect(call(root, 'antigravity', 'pre-invocation', { conversationId: 'a1' })).toBeNull(); // delivered once
    rmSync(dir, { recursive: true, force: true });
  });
});
