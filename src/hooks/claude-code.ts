import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { defaultCliCommand, mergeNestedHooks, nestedHookGroup } from './manifest.js';

export interface ClaudeCodeHookConfig {
  sessionStartCommand: string;
  userPromptSubmitCommand: string;
  preToolUseCommand: string;
  postToolUseCommand: string;
  sessionEndCommand: string;
}

export class ClaudeCodeHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  private commands(cli: string): Record<string, string> {
    return {
      SessionStart: `${cli} hook claude session-start`,
      UserPromptSubmit: `${cli} hook claude prompt-submit`,
      PreToolUse: `${cli} hook claude pre-tool-use`,
      PostToolUse: `${cli} hook claude post-tool-use`,
      PostToolUseFailure: `${cli} hook claude post-tool-use-failure`,
      SessionEnd: `${cli} hook claude session-end`,
      PreCompact: `${cli} hook claude pre-compact`,
    };
  }

  /**
   * Generates the Claude Code hooks block (nested matcher-group format).
   */
  public generateHookManifest(cliBinPath: string = defaultCliCommand()): Record<string, unknown> {
    const hooks: Record<string, unknown> = {};
    for (const [event, command] of Object.entries(this.commands(cliBinPath))) {
      hooks[event] = nestedHookGroup(command);
    }
    return { description: 'AgentRunlog typed engineering memory hook for Claude Code', hooks };
  }

  /**
   * Installs hooks into <project>/.claude/settings.json (the file Claude Code actually reads),
   * merging with whatever the user already has.
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = defaultCliCommand()): string {
    const settingsPath = join(projectRoot, '.claude', 'settings.json');
    mergeNestedHooks(settingsPath, this.commands(cliBinPath));
    return settingsPath;
  }

  /**
   * Executes SessionStart hook: reads pre-compiled active context (< 5ms)
   * and outputs prompt injection text to stdout.
   */
  public handleSessionStart(sessionId: string): string | null {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return null;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'claude_code',
      eventType: 'session_start',
      timestamp: new Date().toISOString(),
      payload: { event: 'Claude Code Session Started' },
    });

    const cache = this.storage.cache.getActiveContext();
    return this.storage.cache.formatPushInjection(cache);
  }

  /**
   * Executes SessionEnd hook: logs session completion
   */
  public handleSessionEnd(sessionId: string): void {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'claude_code',
      eventType: 'session_end',
      timestamp: new Date().toISOString(),
      payload: { event: 'Claude Code Session Ended' },
    });
  }
}
