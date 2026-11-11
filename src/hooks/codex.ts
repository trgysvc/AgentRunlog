import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';

export class CodexHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Generates the Codex CLI hooks.json manifest
   */
  public generateHookManifest(cliBinPath: string = 'runlog'): Record<string, unknown> {
    return {
      description: 'AgentRunlog typed engineering memory hook for OpenAI Codex CLI',
      hooks: {
        SessionStart: [
          {
            type: 'command',
            command: `${cliBinPath} hook codex session-start`,
          },
        ],
        UserPromptSubmit: [
          {
            type: 'command',
            command: `${cliBinPath} hook codex prompt-submit`,
          },
        ],
        PreToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook codex pre-tool-use`,
          },
        ],
        PostToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook codex post-tool-use`,
          },
        ],
        Stop: [
          {
            type: 'command',
            command: `${cliBinPath} hook codex stop`,
          },
        ],
      },
    };
  }

  /**
   * Installs hooks.json into .codex/hooks.json in project root
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = 'runlog'): string {
    const codexDir = join(projectRoot, '.codex');
    if (!existsSync(codexDir)) {
      mkdirSync(codexDir, { recursive: true });
    }

    const manifestPath = join(codexDir, 'hooks.json');
    writeFileSync(manifestPath, JSON.stringify(this.generateHookManifest(cliBinPath), null, 2), 'utf8');
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
