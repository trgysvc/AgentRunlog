import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';

export class AntigravityHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Generates the Google Antigravity hooks.json manifest
   */
  public generateHookManifest(cliBinPath: string = 'runlog'): Record<string, unknown> {
    return {
      description: 'AgentRunlog typed engineering memory hook for Google Antigravity',
      hooks: {
        PreInvocation: [
          {
            type: 'command',
            command: `${cliBinPath} hook antigravity pre-invocation`,
          },
        ],
        PostInvocation: [
          {
            type: 'command',
            command: `${cliBinPath} hook antigravity post-invocation`,
          },
        ],
        PreToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook antigravity pre-tool-use`,
          },
        ],
        PostToolUse: [
          {
            type: 'command',
            command: `${cliBinPath} hook antigravity post-tool-use`,
          },
        ],
        Stop: [
          {
            type: 'command',
            command: `${cliBinPath} hook antigravity stop`,
          },
        ],
      },
    };
  }

  /**
   * Installs hooks.json into .agents/hooks.json in project root
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = 'runlog'): string {
    const agentsDir = join(projectRoot, '.agents');
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }

    const manifestPath = join(agentsDir, 'hooks.json');
    const manifest = this.generateHookManifest(cliBinPath);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
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
