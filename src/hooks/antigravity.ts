import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { defaultCliCommand, globalHooksRegistered, isAgentRunlogEntry, readJsonStrict, removeOurHooks, writeJsonAtomic } from './manifest.js';

export const ANTIGRAVITY_GROUP = 'agentrunlog';

/**
 * Hook group for Antigravity's hooks.json. The file maps a hook NAME to its event config:
 * SessionStart / PreInvocation / PostInvocation / Stop take a flat handler array, while
 * PostToolUse takes `{matcher, hooks:[...]}` groups. PreToolUse is deliberately not registered:
 * it must return a permission `decision`, and we never gate tools.
 */
export function antigravityHookGroup(cliBinPath: string): Record<string, unknown> {
  const handler = (event: string) => ({ type: 'command', command: `${cliBinPath} hook antigravity ${event}`, timeout: 10 });
  return {
    [ANTIGRAVITY_GROUP]: {
      enabled: true,
      SessionStart: [handler('session-start')],
      PreInvocation: [handler('pre-invocation')],
      PostInvocation: [handler('post-invocation')],
      PostToolUse: [{ matcher: '*', hooks: [handler('post-tool-use')] }],
      Stop: [handler('stop')],
    },
  };
}

export class AntigravityHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  public generateHookManifest(cliBinPath: string = defaultCliCommand()): Record<string, unknown> {
    return antigravityHookGroup(cliBinPath);
  }

  /**
   * Installs into .agents/hooks.json (workspace scope), merging with the user's other hook groups.
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = defaultCliCommand(), home?: string): string {
    const manifestPath = join(projectRoot, '.agents', 'hooks.json');
    if (home && globalHooksRegistered('antigravity', home)) {
      removeOurHooks(manifestPath, 'antigravity'); // the global plugin already fires these hooks
      return manifestPath;
    }
    const data = readJsonStrict(manifestPath);
    // Drop our group, and the legacy {description, hooks:{...}} shape older versions wrote.
    delete data[ANTIGRAVITY_GROUP];
    if (data.hooks && isAgentRunlogEntry(data.hooks)) delete data.hooks;
    if (typeof data.description === 'string' && data.description.includes('AgentRunlog')) delete data.description;
    Object.assign(data, this.generateHookManifest(cliBinPath));
    writeJsonAtomic(manifestPath, data);
    return manifestPath;
  }

  /**
   * Executes PreInvocation hook:
   * Enforces < 20ms SLA. Reads active context cache and logs event.
   */
  public handlePreInvocation(sessionId: string, invocationIndex: number = 0): string | null {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return null;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'antigravity',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: { invocationIndex },
    });

    // On initial turn or invocation, push active context
    if (invocationIndex <= 1) {
      const cache = this.storage.cache.getActiveContext();
      return this.storage.cache.formatPushInjection(cache);
    }

    return null;
  }

  /**
   * Executes PostInvocation hook: logs agent response turn
   */
  public handlePostInvocation(sessionId: string, responseSummary?: string): void {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'antigravity',
      eventType: 'agent_response',
      timestamp: new Date().toISOString(),
      payload: { summary: responseSummary || 'Invocation completed' },
    });
  }
}
