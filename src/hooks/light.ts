/**
 * Lightweight hook core (NFR-05). Imports ONLY node builtins plus dependency-free project modules
 * (no zod, gray-matter or MCP SDK), so the bundled hook entry starts in a few milliseconds.
 * No LLM call ever happens here (ZERO_IN_HOOK_LLM).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultSanitizer } from '../sanitizer/index.js';
import { formatPushText } from '../storage/push-format.js';
import { HISTORY_SYNC_INTERVAL_MS, IMPORT_VERSION } from '../compiler/import-version.js';
import { isLockFresh } from '../storage/lock.js';

export type NormalizedPlatform = 'claude_code' | 'antigravity' | 'cursor' | 'codex';
export type MappedEvent =
  | 'session_start'
  | 'prompt_submit'
  | 'pre_tool_use'
  | 'post_tool_use'
  | 'agent_response'
  | 'pre_compact'
  | 'session_end';

export interface LightHookInput {
  platform: string;
  event: string;
  sessionId?: string;
  /** Parsed stdin payload ({} when absent/unparsable). */
  payload: Record<string, unknown>;
  /** True when stdin carried JSON we could parse into an object. */
  payloadParsed: boolean;
  /** `.agentrunlog` directory of the project. */
  storageRoot: string;
  /** Absolute path of the full CLI used for detached compile/bootstrap workers. */
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
}

export function normalizePlatform(raw: string): NormalizedPlatform {
  const p = raw.toLowerCase();
  if (p.includes('antigravity')) return 'antigravity';
  if (p.includes('cursor')) return 'cursor';
  if (p.includes('codex')) return 'codex';
  return 'claude_code';
}

/**
 * Maps a platform hook name to a raw event type.
 * `stop` fires at the end of EVERY assistant turn on all platforms, so it is a turn boundary
 * (agent_response) and never a session end (PRD NFR-06 / audit R10).
 */
export function mapEvent(event: string): MappedEvent | null {
  const e = event.toLowerCase();
  if (e === 'session-start' || e === 'sessionstart') return 'session_start';
  if (e.includes('prompt') || e === 'pre-invocation') return 'prompt_submit';
  if (e === 'post-invocation' || e === 'stop' || e === 'after-agent-response') return 'agent_response';
  if (e.includes('pre-tool')) return 'pre_tool_use';
  if (e.includes('post-tool')) return 'post_tool_use';
  if (e === 'pre-compact') return 'pre_compact';
  if (e === 'session-end' || e === 'sessionend') return 'session_end';
  return null;
}

function isPushEvent(event: string): boolean {
  const e = event.toLowerCase();
  return e === 'session-start' || e === 'sessionstart';
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function spawnWorker(cliPath: string, subcommand: string, env: NodeJS.ProcessEnv, cwd: string): void {
  try {
    const child = spawn(process.execPath, [cliPath, subcommand], {
      detached: true,
      stdio: 'ignore',
      cwd,
      env: { ...env, AGENTRUNLOG_INTERNAL: '1', AGENTRUNLOG_CALLER: 'agentrunlog-compiler' }, // NFR-09 recursion shield
    });
    child.unref();
  } catch {
    // A failed spawn must never break the host agent.
  }
}

/** Reads the uncompiled-turn counter and optionally bumps it (best-effort, atomic replace). */
function bumpPending(cacheDir: string, by: number): number {
  const file = join(cacheDir, 'pending.json');
  const cur = Number(readJson(file)?.turns) || 0;
  const next = cur + by;
  if (by > 0) {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ turns: next }), 'utf8');
      renameSync(tmp, file);
    } catch {}
  }
  return next;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '.');
  return new RegExp(esc);
}

/** NFR-03: true when any string in the payload's tool input/path fields matches an exclusion glob. */
function matchesExclusion(payload: Record<string, unknown>, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const strings: string[] = [];
  const collect = (v: unknown, depth = 0) => {
    if (typeof v === 'string') strings.push(v);
    else if (depth < 3 && v && typeof v === 'object') for (const x of Object.values(v as object)) collect(x, depth + 1);
  };
  collect(payload.tool_input);
  collect(payload.toolInput);
  collect(payload.file_path);
  collect(payload.path);
  collect(payload.command);
  const res = patterns.map(globToRegExp);
  return strings.some((str) => res.some((r) => r.test(str)));
}

function failureKey(payload: Record<string, any>): string | null {
  const ti = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const failed =
    payload.hook_event_name === 'PostToolUseFailure' ||
    (typeof payload.error === 'string' && payload.error.length > 0) ||
    (typeof payload.exitCode === 'number' && payload.exitCode !== 0);
  if (!failed) return null;
  const cmd = String(ti.command ?? payload.command ?? payload.tool_name ?? payload.tool ?? '').replace(/\s+/g, ' ').trim();
  return cmd ? cmd.slice(0, 160) : null;
}

/** Returns an advisory text on the 2nd failure of the same command in this session (never blocks). */
function repeatedFailureGuard(cacheDir: string, sessionId: string, payload: Record<string, any>): string | null {
  try {
    const key = failureKey(payload);
    if (!key) return null;
    const file = join(cacheDir, 'failcount.json');
    let st = readJson(file);
    if (!st || st.sessionId !== sessionId) st = { sessionId, counts: {} };
    const n = (st.counts[key] = (Number(st.counts[key]) || 0) + 1);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(st), 'utf8');
    if (n !== 2) return null;
    const index = readJson(join(cacheDir, 'guard_index.json'));
    if (!Array.isArray(index)) return null;
    const lk = key.toLowerCase();
    const hits = index.filter((g: any) => {
      const gk = String(g.key || '').toLowerCase();
      return gk.length >= 4 && (lk.includes(gk) || gk.includes(lk));
    });
    if (!hits.length) return null;
    return ['<!-- AGENTRUNLOG_GUARD -->', '⚠️ Same command failed twice. AgentRunlog has prior knowledge (advisory, not blocking):', ...hits.slice(0, 2).map((h: any) => `- ${h.text}`)].join('\n');
  } catch {
    return null;
  }
}

export function runLightHook(input: LightHookInput): string | null {
  const env = input.env ?? process.env;
  if (env.AGENTRUNLOG_INTERNAL === '1' || env.AGENTRUNLOG_SKIP === '1') return null;
  // NFR-09 second layer: transcript-level caller marker
  if (env.AGENTRUNLOG_CALLER === 'agentrunlog-compiler' || input.payload.caller === 'agentrunlog-compiler') return null;

  const platform = normalizePlatform(input.platform);
  const event = input.event.toLowerCase();
  const mapped = mapEvent(event);
  const rawDir = join(input.storageRoot, 'raw');
  const cacheDir = join(input.storageRoot, 'cache');
  const payload = input.payload;

  // NFR-03: per-project opt-out (`runlog pause`, config.privacy.enabled=false) and exclusion patterns
  const cfg = readJson(join(input.storageRoot, 'config.json'));
  const optedOut = existsSync(join(cacheDir, 'paused')) || cfg?.privacy?.enabled === false;
  const excluded = !optedOut && matchesExclusion(payload, Array.isArray(cfg?.privacy?.excludePatterns) ? cfg.privacy.excludePatterns : []);

  // 1. Capture the event. Without a session id we refuse to guess a "daily" session for junk input.
  const idFromPayload = payload.conversationId ?? payload.conversation_id ?? payload.session_id ?? payload.sessionId;
  let sessionId = input.sessionId || (idFromPayload ? String(idFromPayload) : '');
  if (!sessionId && input.payloadParsed) sessionId = `sess_${new Date().toISOString().slice(0, 10)}`;

  if (mapped && sessionId && !optedOut && !excluded) {
    try {
      mkdirSync(rawDir, { recursive: true });
      mkdirSync(cacheDir, { recursive: true });
      const line =
        JSON.stringify({
          sessionId,
          platform,
          eventType: mapped,
          timestamp: new Date().toISOString(),
          payload: defaultSanitizer.redactObject(payload),
        }) + '\n';
      const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
      appendFileSync(join(rawDir, `session-${safeId}.jsonl`), line, 'utf8');
    } catch {
      // Capture failure must never block the agent.
    }
  }

  // 1b. Repeated-failure guardrail: on the 2nd failure of the same command in a session, surface the known fix / dead end.
  let guard: string | null = null;
  if (mapped === 'post_tool_use' && sessionId && !optedOut && !excluded) guard = repeatedFailureGuard(cacheDir, sessionId, payload);

  // 2. Push: static pre-compiled cache only (FR-19).
  let push: string | null = null;
  if (isPushEvent(event)) {
    const cache = readJson(join(cacheDir, 'active_context.json'));
    push = formatPushText(cache);
  }
  if (guard) push = guard;

  if (!input.cliPath) return push;
  const projectDir = dirname(input.storageRoot);

  // 3. Background workers. Hooks never wait for them.
  const bootstrapDone = existsSync(join(cacheDir, 'bootstrap.done'));
  if (!bootstrapDone) {
    if (!isLockFresh(join(cacheDir, 'bootstrap.lock'))) spawnWorker(input.cliPath, 'bootstrap', env, projectDir);
    return push;
  }

  // Automatic history sync: at most every 30 min, and immediately when the import version is outdated.
  if (mapped === 'session_start' && !isLockFresh(join(cacheDir, 'history.lock'))) {
    const sync = readJson(join(cacheDir, 'history_sync.json'));
    if (!sync || sync.version !== IMPORT_VERSION || Date.now() - Number(sync.at || 0) > HISTORY_SYNC_INTERVAL_MS) {
      spawnWorker(input.cliPath, 'sync-history', env, projectDir);
    }
  }

  const turnEvent = mapped === 'prompt_submit';
  const pendingTurns = bumpPending(cacheDir, turnEvent ? 1 : 0);
  const threshold = Number(readJson(join(input.storageRoot, 'config.json'))?.compiler?.uncompiledTurnsThreshold) || 25;
  const shouldCompile =
    mapped === 'session_end' ||
    mapped === 'pre_compact' ||
    pendingTurns >= threshold ||
    // crash recovery: a fresh session start with leftovers from a session that never ended
    (mapped === 'session_start' && pendingTurns > 0);

  if (shouldCompile && !isLockFresh(join(cacheDir, 'compile.lock'))) {
    spawnWorker(input.cliPath, 'compile', env, projectDir);
  }
  return push;
}

/**
 * Platform-specific stdout. Cursor injects via `additional_context`; Antigravity hooks must answer
 * with JSON (context goes in `injectSteps`, Stop needs a `decision`); others take plain text.
 */
export function formatHookOutput(platform: string, event: string, push: string | null): string | null {
  const p = platform.toLowerCase();
  const e = event.toLowerCase();
  if (push && push.startsWith('<!-- AGENTRUNLOG_GUARD -->')) {
    // Tool-time advisory: only Claude Code documents additionalContext for post-tool hooks.
    if (p.includes('claude') && (e === 'post-tool-use' || e === 'posttooluse' || e === 'post-tool-use-failure' || e === 'posttoolusefailure')) {
      const name = e.includes('failure') ? 'PostToolUseFailure' : 'PostToolUse';
      return JSON.stringify({ hookSpecificOutput: { hookEventName: name, additionalContext: push } });
    }
    return null;
  }
  if (p.includes('cursor')) return push ? JSON.stringify({ additional_context: push }) : null;
  if (p.includes('antigravity')) {
    if (e === 'stop') return JSON.stringify({ decision: 'allow' });
    if (e === 'session-start' && push) return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: push } }] });
    if (e === 'pre-invocation' || e === 'post-invocation') return JSON.stringify({ injectSteps: [] });
    return '{}';
  }
  return push;
}
