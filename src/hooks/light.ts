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

function isPushEvent(platform: NormalizedPlatform, event: string): boolean {
  const e = event.toLowerCase();
  if (platform === 'antigravity') return e === 'pre-invocation';
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
      env: { ...env, AGENTRUNLOG_INTERNAL: '1' }, // NFR-09 recursion shield
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

export function runLightHook(input: LightHookInput): string | null {
  const env = input.env ?? process.env;
  if (env.AGENTRUNLOG_INTERNAL === '1' || env.AGENTRUNLOG_SKIP === '1') return null;

  const platform = normalizePlatform(input.platform);
  const event = input.event.toLowerCase();
  const mapped = mapEvent(event);
  const rawDir = join(input.storageRoot, 'raw');
  const cacheDir = join(input.storageRoot, 'cache');
  const payload = input.payload;

  // 1. Capture the event. Without a session id we refuse to guess a "daily" session for junk input.
  const idFromPayload = payload.conversation_id ?? payload.session_id ?? payload.sessionId;
  let sessionId = input.sessionId || (idFromPayload ? String(idFromPayload) : '');
  if (!sessionId && input.payloadParsed) sessionId = `sess_${new Date().toISOString().slice(0, 10)}`;

  if (mapped && sessionId) {
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

  // 2. Push: static pre-compiled cache only (FR-19).
  let push: string | null = null;
  if (isPushEvent(platform, event)) {
    const cache = readJson(join(cacheDir, 'active_context.json'));
    push = formatPushText(cache);
  }

  if (!input.cliPath) return push;
  const projectDir = dirname(input.storageRoot);

  // 3. Background workers. Hooks never wait for them.
  const bootstrapDone = existsSync(join(cacheDir, 'bootstrap.done'));
  if (!bootstrapDone) {
    if (!isLockFresh(join(cacheDir, 'bootstrap.lock'))) spawnWorker(input.cliPath, 'bootstrap', env, projectDir);
    return push;
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
