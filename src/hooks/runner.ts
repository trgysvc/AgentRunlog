import { spawn } from 'node:child_process';
import { type StorageManager } from '../storage/index.js';
import { type HookManager } from './index.js';

export interface HookInvocationArgs {
  platform: string;
  event: string;
  sessionId?: string;
  cliPath?: string;
}

/**
 * Reads process.stdin with a non-blocking timeout (< 15ms)
 */
export async function readStdinWithTimeout(timeoutMs: number = 15): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    }, timeoutMs);

    if (process.stdin.isTTY) {
      clearTimeout(timer);
      return resolve('');
    }

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });

    process.stdin.on('end', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(data);
      }
    });

    process.stdin.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(data);
      }
    });
  });
}

export class HookRunner {
  private storage: StorageManager;
  private hooks: HookManager;

  constructor(storage: StorageManager, hooks: HookManager) {
    this.storage = storage;
    this.hooks = hooks;
  }

  /**
   * Spawns detached compiler worker in the background (NFR-06, NFR-09)
   */
  public triggerDetachedCompiler(cliPath: string): void {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return;
    }

    try {
      const child = spawn(process.execPath, [cliPath, 'compile'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          AGENTRUNLOG_INTERNAL: '1', // NFR-09: Recursion shield
        },
      });
      child.unref();
    } catch (err) {
      console.warn('Could not spawn detached compiler worker:', err);
    }
  }

  /**
   * Executes hook logic with stdin payload reading and fast exit
   */
  public async runHook(args: HookInvocationArgs): Promise<string | null> {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return null;
    }

    const rawStdin = await readStdinWithTimeout(15);
    let payload: Record<string, unknown> = {};

    if (rawStdin.trim().length > 0) {
      try {
        payload = JSON.parse(rawStdin);
      } catch {
        payload = { rawText: rawStdin.trim() };
      }
    }

    const defaultDailySession = `sess_${new Date().toISOString().slice(0, 10)}`;
    const sessionId =
      args.sessionId ||
      String(payload.conversation_id || payload.session_id || payload.sessionId || defaultDailySession);

    const rawPlatform = args.platform.toLowerCase();
    const event = args.event.toLowerCase();

    let normalizedPlatform: 'claude_code' | 'antigravity' | 'cursor' | 'codex' = 'claude_code';
    if (rawPlatform.includes('claude')) normalizedPlatform = 'claude_code';
    else if (rawPlatform.includes('antigravity')) normalizedPlatform = 'antigravity';
    else if (rawPlatform.includes('cursor')) normalizedPlatform = 'cursor';
    else if (rawPlatform.includes('codex')) normalizedPlatform = 'codex';

    // 1. Log event with full stdin payload
    let mappedEventType:
      | 'session_start'
      | 'prompt_submit'
      | 'pre_tool_use'
      | 'post_tool_use'
      | 'agent_response'
      | 'pre_compact'
      | 'session_end'
      | null = null;

    if (event === 'session-start') mappedEventType = 'session_start';
    else if (event.includes('prompt') || event === 'pre-invocation') mappedEventType = 'prompt_submit';
    else if (event === 'post-invocation') mappedEventType = 'agent_response';
    else if (event.includes('pre-tool')) mappedEventType = 'pre_tool_use';
    else if (event.includes('post-tool')) mappedEventType = 'post_tool_use';
    else if (event === 'pre-compact') mappedEventType = 'pre_compact';
    else if (event === 'session-end' || event === 'stop') mappedEventType = 'session_end';

    if (mappedEventType) {
      this.storage.logger.logEvent({
        sessionId,
        platform: normalizedPlatform,
        eventType: mappedEventType,
        timestamp: new Date().toISOString(),
        payload,
      });
    }

    // 2. Handle push events (read pre-compiled cache < 5ms)
    let pushText: string | null = null;
    if (
      (normalizedPlatform === 'claude_code' && event === 'session-start') ||
      (normalizedPlatform === 'antigravity' && event === 'pre-invocation') ||
      (normalizedPlatform === 'codex' && event === 'session-start')
    ) {
      const cache = this.storage.cache.getActiveContext();
      pushText = this.storage.cache.formatPushInjection(cache);
    }

    // 3. Handle session completion events (Trigger detached background compiler)
    const isCompletionEvent =
      event === 'session-end' || event === 'stop' || event === 'pre-compact';

    if (isCompletionEvent && args.cliPath) {
      this.triggerDetachedCompiler(args.cliPath);
    }

    return pushText;
  }
}
