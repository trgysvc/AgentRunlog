import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { defaultCliCommand, globalHooksRegistered, mergeNestedHooks, nestedHookGroup, removeOurHooks } from './manifest.js';

export class CodexHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  private commands(cli: string): Record<string, string> {
    return {
      SessionStart: `${cli} hook codex session-start`,
      UserPromptSubmit: `${cli} hook codex prompt-submit`,
      PostToolUse: `${cli} hook codex post-tool-use`,
      PreCompact: `${cli} hook codex pre-compact`,
      Stop: `${cli} hook codex stop`,
    };
  }

  /**
   * Generates the Codex CLI hooks.json manifest (matcher groups with nested hooks).
   */
  public generateHookManifest(cliBinPath: string = defaultCliCommand()): Record<string, unknown> {
    const hooks: Record<string, unknown> = {};
    for (const [event, command] of Object.entries(this.commands(cliBinPath))) {
      hooks[event] = nestedHookGroup(command);
    }
    return { description: 'AgentRunlog typed engineering memory hook for OpenAI Codex CLI', hooks };
  }

  /**
   * Installs hooks into <project>/.codex/hooks.json, merging with existing hooks.
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = defaultCliCommand(), home?: string): string {
    const manifestPath = join(projectRoot, '.codex', 'hooks.json');
    if (home && globalHooksRegistered('codex', home)) removeOurHooks(manifestPath, 'codex');
    else mergeNestedHooks(manifestPath, this.commands(cliBinPath));
    return manifestPath;
  }

  /**
   * Executes SessionStart hook for Codex CLI (< 20ms SLA)
   */
  public handleSessionStart(sessionId: string): string | null {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return null;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'codex',
      eventType: 'session_start',
      timestamp: new Date().toISOString(),
      payload: { event: 'Codex Session Started' },
    });

    const cache = this.storage.cache.getActiveContext();
    return this.storage.cache.formatPushInjection(cache);
  }
}
