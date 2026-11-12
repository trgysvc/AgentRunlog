import { spawn } from 'node:child_process';
import { runLightHook } from './light.js';
import { type StorageManager } from '../storage/index.js';
import { type HookManager } from './index.js';

export interface HookInvocationArgs {
  platform: string;
  event: string;
  sessionId?: string;
  cliPath?: string;
}

const STDIN_CAP_MS = 1000;

/**
 * Reads process.stdin until `end` (hook payloads arrive in several chunks), capped by timeoutMs,
 * and releases the stream afterwards so the process can exit.
 */
export async function readStdinWithTimeout(timeoutMs: number = STDIN_CAP_MS): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.unref?.();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
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
   * Spawns detached background CLI subcommand (compile | bootstrap) with NFR-09 recursion shield
   */
  public triggerDetachedWorker(cliPath: string, subcommand: 'compile' | 'bootstrap' = 'compile'): void {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return;
    }

    try {
      const child = spawn(process.execPath, [cliPath, subcommand], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          AGENTRUNLOG_INTERNAL: '1', // NFR-09: Recursion shield
        },
      });
      child.unref();
    } catch (err) {
      console.warn(`Could not spawn detached ${subcommand} worker:`, err);
    }
  }

  public triggerDetachedCompiler(cliPath: string): void {
    this.triggerDetachedWorker(cliPath, 'compile');
  }

  /**
   * Executes hook logic: delegates to the dependency-free light core shared with the bundled
   * hook entry, so both paths behave identically.
   */
  public async runHook(args: HookInvocationArgs): Promise<string | null> {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return null;
    }

    const rawStdin = await readStdinWithTimeout(STDIN_CAP_MS);
    let payload: Record<string, unknown> = {};
    let payloadParsed = false;
    if (rawStdin.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawStdin);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
          payloadParsed = true;
        }
      } catch {
        // unparsable payload: never invent a session for it
      }
    }

    return runLightHook({
      platform: args.platform,
      event: args.event,
      sessionId: args.sessionId,
      payload,
      payloadParsed: payloadParsed || !!args.sessionId,
      storageRoot: this.storage.paths.root,
      cliPath: args.cliPath,
    });
  }
}
