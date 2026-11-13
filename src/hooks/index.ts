import { ClaudeCodeHookAdapter } from './claude-code.js';
import { AntigravityHookAdapter } from './antigravity.js';
import { CursorHookAdapter } from './cursor.js';
import { CodexHookAdapter } from './codex.js';
import { HookRunner } from './runner.js';
import { type StorageManager } from '../storage/index.js';

export * from './claude-code.js';
export * from './antigravity.js';
export * from './cursor.js';
export * from './codex.js';
export * from './runner.js';

export class HookManager {
  public claude: ClaudeCodeHookAdapter;
  public antigravity: AntigravityHookAdapter;
  public cursor: CursorHookAdapter;
  public codex: CodexHookAdapter;
  public runner: HookRunner;

  constructor(storage: StorageManager) {
    this.claude = new ClaudeCodeHookAdapter(storage);
    this.antigravity = new AntigravityHookAdapter(storage);
    this.cursor = new CursorHookAdapter(storage);
    this.codex = new CodexHookAdapter(storage);
    this.runner = new HookRunner(storage, this);
  }

  /**
   * Installs hooks for specified platforms or all 4 by default
   */
  public installAll(
    projectRoot: string = process.cwd(),
    cliBinPath?: string,
    home?: string
  ): Record<string, string | { hooksPath: string; rulesPath: string }> {
    return {
      claude: this.claude.install(projectRoot, cliBinPath, home),
      antigravity: this.antigravity.install(projectRoot, cliBinPath, home),
      cursor: this.cursor.install(projectRoot, cliBinPath, home),
      codex: this.codex.install(projectRoot, cliBinPath, home),
    };
  }
}
