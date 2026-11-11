import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';

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

  /**
   * Generates the Claude Code hooks.json manifest
   */
  public generateHookManifest(cliBinPath: string = 'runlog'): Record<string, unknown> {
    return {
      description: 'AgentRunlog typed engineering memory hook for Claude Code',
      hooks: {
        SessionStart: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude session-start`,
          },
        ],
        UserPromptSubmit: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude prompt-submit`,
          },
        ],
        PreToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude pre-tool-use`,
          },
        ],
        PostToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude post-tool-use`,
          },
        ],
        SessionEnd: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude session-end`,
          },
        ],
        PreCompact: [
          {
            type: 'command',
            command: `${cliBinPath} hook claude pre-compact`,
          },
        ],
      },
    };
  }

  /**
   * Installs hooks.json into .claude/hooks.json in project root
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = 'runlog'): string {
    const claudeDir = join(projectRoot, '.claude');
    if (!existsSync(claudeDir)) {
      mkdirSync(claudeDir, { recursive: true });
    }

    const manifestPath = join(claudeDir, 'hooks.json');
    const manifest = this.generateHookManifest(cliBinPath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifestPath;
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
