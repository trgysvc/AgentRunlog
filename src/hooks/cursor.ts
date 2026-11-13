import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { defaultCliCommand, isAgentRunlogEntry, readJsonStrict, writeJsonAtomic } from './manifest.js';

export class CursorHookAdapter {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /**
   * Generates the Cursor hooks.json manifest
   */
  public generateHookManifest(cliBinPath: string = defaultCliCommand()): Record<string, unknown> {
    return {
      version: 1,
      hooks: {
        sessionStart: [
          {
            command: `${cliBinPath} hook cursor session-start`,
          },
        ],
        beforeSubmitPrompt: [
          {
            command: `${cliBinPath} hook cursor before-submit-prompt`,
          },
        ],
        preToolUse: [
          {
            command: `${cliBinPath} hook cursor pre-tool-use`,
          },
        ],
        postToolUse: [
          {
            command: `${cliBinPath} hook cursor post-tool-use`,
          },
        ],
        postToolUseFailure: [
          {
            command: `${cliBinPath} hook cursor post-tool-use-failure`,
          },
        ],
        preCompact: [
          {
            command: `${cliBinPath} hook cursor pre-compact`,
          },
        ],
        stop: [
          {
            command: `${cliBinPath} hook cursor stop`,
          },
        ],
      },
    };
  }

  /**
   * Generates the .cursorrules / .cursor/rules/agentrunlog.mdc fallback instructions (FR-14)
   */
  public generateCursorRules(): string {
    return `---
description: "AgentRunlog Engineering Memory Integration"
globs: ["*"]
alwaysApply: true
---

# AgentRunlog Engineering Memory Rule

You are connected to the project's engineering memory through the \`agentrunlog\` MCP server.
To prevent repeating past mistakes and to preserve architectural decisions:

1. **Before attempting architectural changes, major refactors, or new dependencies:**
   - Call MCP tool \`check_dead_ends\` with your intended approach.
   - If a known dead-end is flagged, adhere to its \`retryConditions\` or choose a verified alternative.

2. **When unsure of architectural patterns or previously agreed choices:**
   - Call MCP tool \`search_runlog\` (e.g. query "authentication", "database", "api").
   - Call MCP tool \`get_active_context\` to review current active decisions.

3. **Autonomously record engineering events (without waiting for the user to say "save this"):**
   - When the user confirms an architectural choice, silently call \`record_decision\` (with \`supersedes\` if replacing an older decision).
   - When an approach fundamentally fails, silently call \`record_dead_end\` with clear \`retryConditions\`.
   - When you fix a complex bug, silently call \`record_rca\`.

4. **Never implement an approach that violates an active Decision without explicit user confirmation.**
`;
  }

  /**
   * Installs hooks.json and .cursorrules into the project
   */
  public install(projectRoot: string = process.cwd(), cliBinPath: string = defaultCliCommand()): {
    hooksPath: string;
    rulesPath: string;
  } {
    const cursorDir = join(projectRoot, '.cursor');
    if (!existsSync(cursorDir)) {
      mkdirSync(cursorDir, { recursive: true });
    }

    // Merge into an existing hooks.json: keep the user's own hooks, replace only ours.
    const hooksPath = join(cursorDir, 'hooks.json');
    const ours = this.generateHookManifest(cliBinPath) as { version: number; hooks: Record<string, Array<{ command: string }>> };
    const existing = readJsonStrict(hooksPath) as { version?: number; hooks?: Record<string, Array<{ command?: string }>> };
    const merged: Record<string, unknown[]> = {};
    for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
      merged[event] = (Array.isArray(entries) ? entries : []).filter((e) => !isAgentRunlogEntry(e));
    }
    for (const [event, entries] of Object.entries(ours.hooks)) {
      merged[event] = [...(merged[event] ?? []), ...entries];
    }
    writeJsonAtomic(hooksPath, { ...existing, version: existing.version ?? ours.version, hooks: merged });

    // Own rules file: never clobber the user's .cursorrules.
    const rulesDir = join(cursorDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const rulesPath = join(rulesDir, 'agentrunlog.mdc');
    writeFileSync(rulesPath, this.generateCursorRules(), 'utf8');

    return { hooksPath, rulesPath };
  }

  /**
   * Handles beforeSubmitPrompt event (< 20ms SLA)
   */
  public handlePromptSubmit(sessionId: string, promptText?: string): void {
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return;
    }

    this.storage.logger.logEvent({
      sessionId,
      platform: 'cursor',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: { promptLength: promptText?.length || 0 },
    });
  }
}
