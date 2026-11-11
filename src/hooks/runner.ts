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
    const rawStdin = await readStdinWithTimeout(15);
    let payload: Record<string, unknown> = {};

    if (rawStdin.trim().length > 0) {
      try {
        payload = JSON.parse(rawStdin);
      } catch {
        payload = { rawText: rawStdin.trim() };
      }
    }

    const sessionId =
      args.sessionId ||
      String(payload.session_id || payload.sessionId || `sess_${Date.now()}`);

    const platform = args.platform.toLowerCase();
    const event = args.event.toLowerCase();

    // 1. Log event
    if (event.includes('tool-use') || event.includes('prompt')) {
      this.storage.logger.logEvent({
        sessionId,
        platform: platform as any,
        eventType: event.includes('pre-tool')
          ? 'pre_tool_use'
          : event.includes('post-tool')
            ? 'post_tool_use'
            : 'prompt_submit',
        timestamp: new Date().toISOString(),
        payload,
      });
    }

    // 2. Handle push events
    let pushText: string | null = null;
    if (platform === 'claude' && event === 'session-start') {
      pushText = this.hooks.claude.handleSessionStart(sessionId);
    } else if (platform === 'antigravity' && event === 'pre-invocation') {
      pushText = this.hooks.antigravity.handlePreInvocation(sessionId, 1);
    } else if (platform === 'codex' && event === 'session-start') {
      pushText = this.hooks.codex.handleSessionStart(sessionId);
    } else if (platform === 'cursor' && event === 'before-submit-prompt') {
      this.hooks.cursor.handlePromptSubmit(sessionId, String(payload.text || ''));
    }

    // 3. Handle session completion events (Trigger detached compiler)
    const isCompletionEvent =
      event === 'session-end' || event === 'stop' || event === 'pre-compact';

    if (isCompletionEvent && args.cliPath) {
      this.triggerDetachedCompiler(args.cliPath);
    }

    return pushText;
  }
}
