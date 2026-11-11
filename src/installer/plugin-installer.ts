import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface PlatformInstallResult {
  platform: 'antigravity' | 'claude' | 'cursor' | 'codex';
  success: boolean;
  paths: string[];
  notes?: string;
}

export interface InstallerOptions {
  homeDir?: string;
  pkgRoot?: string;
  nodeExec?: string;
  cliEntry?: string;
}

function findPackageRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(current, 'package.json'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, '../..');
}

export class UniversalPluginInstaller {
  private home: string;
  private pkgRoot: string;
  private nodeExec: string;
  private cliEntry: string;

  constructor(options: InstallerOptions = {}) {
    this.home = options.homeDir || homedir();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    this.pkgRoot = options.pkgRoot || findPackageRoot(__dirname);
    this.nodeExec = options.nodeExec || process.execPath;
    this.cliEntry = options.cliEntry || resolve(this.pkgRoot, 'dist/cli/index.js');
  }

  private getHookCommand(platform: string, event: string): string {
    return `"${this.nodeExec}" "${this.cliEntry}" hook ${platform} ${event}`;
  }

  /**
   * Installs AgentRunlog globally across all 4 supported platforms
   */
  public installAll(): PlatformInstallResult[] {
    return [
      this.installAntigravity(),
      this.installClaudeCode(),
      this.installCursor(),
      this.installCodex(),
    ];
  }

  /**
   * 1. Google Antigravity Native Plugin (~/.gemini/config/plugins/agentrunlog/)
   */
  public installAntigravity(): PlatformInstallResult {
    const pluginDir = join(this.home, '.gemini', 'config', 'plugins', 'agentrunlog');
    const rulesDir = join(pluginDir, 'rules');
    const skillsDir = join(pluginDir, 'skills', 'agentrunlog');
    mkdirSync(rulesDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });

    const writtenPaths: string[] = [];

    for (const rel of ['plugin.json', 'rules/AGENTS.md', 'skills/agentrunlog/SKILL.md']) {
      const srcPath = join(this.pkgRoot, rel);
      const destPath = join(pluginDir, rel);
      if (existsSync(srcPath)) {
        copyFileSync(srcPath, destPath);
        writtenPaths.push(destPath);
      }
    }

    const mcpConfigPath = join(pluginDir, 'mcp_config.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            agentrunlog: {
              command: this.nodeExec,
              args: [this.cliEntry, 'mcp'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
    writtenPaths.push(mcpConfigPath);

    const hooksPath = join(pluginDir, 'hooks.json');
    writeFileSync(
      hooksPath,
      JSON.stringify(
        {
          description: 'AgentRunlog typed engineering memory hooks for Google Antigravity',
          hooks: {
            PreInvocation: [{ type: 'command', command: this.getHookCommand('antigravity', 'pre-invocation') }],
            PostInvocation: [{ type: 'command', command: this.getHookCommand('antigravity', 'post-invocation') }],
            PostToolUse: [{ type: 'command', command: this.getHookCommand('antigravity', 'post-tool-use') }],
            Stop: [{ type: 'command', command: this.getHookCommand('antigravity', 'stop') }],
          },
        },
        null,
        2
      ),
      'utf8'
    );
    writtenPaths.push(hooksPath);

    // Clean standalone duplicate in ~/.gemini/config/mcp_config.json if present
    const userMcpPath = join(this.home, '.gemini', 'config', 'mcp_config.json');
    if (existsSync(userMcpPath)) {
      try {
        const userMcp = JSON.parse(readFileSync(userMcpPath, 'utf8'));
        if (userMcp?.mcpServers?.agentrunlog) {
          delete userMcp.mcpServers.agentrunlog;
          writeFileSync(userMcpPath, JSON.stringify(userMcp, null, 2), 'utf8');
        }
      } catch {}
    }

    return { platform: 'antigravity', success: true, paths: writtenPaths };
  }

  /**
   * 2. Claude Code Global Setup (~/.claude.json MCP, ~/.claude/settings.json Hooks, ~/.claude/skills/agentrunlog/)
   */
  public installClaudeCode(): PlatformInstallResult {
    const claudeDir = join(this.home, '.claude');
    const skillDir = join(claudeDir, 'skills', 'agentrunlog');
    mkdirSync(skillDir, { recursive: true });
    const writtenPaths: string[] = [];

    // 2A. Skill
    const srcSkill = join(this.pkgRoot, 'skills', 'agentrunlog', 'SKILL.md');
    const destSkill = join(skillDir, 'SKILL.md');
    if (existsSync(srcSkill)) {
      copyFileSync(srcSkill, destSkill);
      writtenPaths.push(destSkill);
    }

    // 2B. MCP Server in ~/.claude.json (merge non-destructively)
    const claudeJsonPath = join(this.home, '.claude.json');
    let claudeJson: Record<string, any> = {};
    if (existsSync(claudeJsonPath)) {
      try {
        claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
      } catch {}
    }
    claudeJson.mcpServers = claudeJson.mcpServers || {};
    claudeJson.mcpServers.agentrunlog = {
      type: 'stdio',
      command: this.nodeExec,
      args: [this.cliEntry, 'mcp'],
    };
    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2), 'utf8');
    writtenPaths.push(claudeJsonPath);

    // 2C. Hooks in ~/.claude/settings.json (merge non-destructively, idempotent)
    const settingsPath = join(claudeDir, 'settings.json');
    let settings: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch {}
    }
    settings.hooks = settings.hooks || {};

    const claudeHookMap: Record<string, string> = {
      SessionStart: this.getHookCommand('claude', 'session-start'),
      UserPromptSubmit: this.getHookCommand('claude', 'prompt-submit'),
      PostToolUse: this.getHookCommand('claude', 'post-tool-use'),
      PreCompact: this.getHookCommand('claude', 'pre-compact'),
      SessionEnd: this.getHookCommand('claude', 'session-end'),
    };

    for (const [event, cmd] of Object.entries(claudeHookMap)) {
      const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      // Remove older agentrunlog hooks before re-adding cleanly
      const filtered = existing.filter((entry: any) => {
        const entryStr = JSON.stringify(entry);
        return !entryStr.includes('agentrunlog') && !entryStr.includes('runlog hook');
      });
      filtered.push({
        matcher: '',
        hooks: [{ type: 'command', command: cmd }],
      });
      settings.hooks[event] = filtered;
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    writtenPaths.push(settingsPath);

    return { platform: 'claude', success: true, paths: writtenPaths };
  }

  /**
   * 3. Cursor Global Setup (~/.cursor/mcp.json, ~/.cursor/hooks.json, ~/.cursor/rules/agentrunlog.mdc)
   */
  public installCursor(): PlatformInstallResult {
    const cursorDir = join(this.home, '.cursor');
    const rulesDir = join(cursorDir, 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const writtenPaths: string[] = [];

    // 3A. MCP Server in ~/.cursor/mcp.json
    const mcpPath = join(cursorDir, 'mcp.json');
    let mcpData: Record<string, any> = {};
    if (existsSync(mcpPath)) {
      try {
        mcpData = JSON.parse(readFileSync(mcpPath, 'utf8'));
      } catch {}
    }
    mcpData.mcpServers = mcpData.mcpServers || {};
    mcpData.mcpServers.agentrunlog = {
      command: this.nodeExec,
      args: [this.cliEntry, 'mcp'],
    };
    writeFileSync(mcpPath, JSON.stringify(mcpData, null, 2), 'utf8');
    writtenPaths.push(mcpPath);

    // 3B. Hooks in ~/.cursor/hooks.json (merge non-destructively)
    const hooksPath = join(cursorDir, 'hooks.json');
    let hooksData: Record<string, any> = { version: 1, hooks: {} };
    if (existsSync(hooksPath)) {
      try {
        hooksData = JSON.parse(readFileSync(hooksPath, 'utf8'));
      } catch {}
    }
    hooksData.version = hooksData.version || 1;
    hooksData.hooks = hooksData.hooks || {};

    const cursorHookMap: Record<string, string> = {
      beforeSubmitPrompt: this.getHookCommand('cursor', 'before-submit-prompt'),
      preToolUse: this.getHookCommand('cursor', 'pre-tool-use'),
      postToolUse: this.getHookCommand('cursor', 'post-tool-use'),
      preCompact: this.getHookCommand('cursor', 'pre-compact'),
      stop: this.getHookCommand('cursor', 'stop'),
    };

    for (const [event, cmd] of Object.entries(cursorHookMap)) {
      const existing = Array.isArray(hooksData.hooks[event]) ? hooksData.hooks[event] : [];
      const filtered = existing.filter((entry: any) => {
        const entryStr = JSON.stringify(entry);
        return !entryStr.includes('agentrunlog') && !entryStr.includes('runlog hook');
      });
      filtered.push({ command: cmd });
      hooksData.hooks[event] = filtered;
    }

    writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2), 'utf8');
    writtenPaths.push(hooksPath);

    // 3C. Global Cursor Rule (~/.cursor/rules/agentrunlog.mdc)
    const rulePath = join(rulesDir, 'agentrunlog.mdc');
    const rulesSrc = join(this.pkgRoot, 'rules', 'AGENTS.md');
    const ruleBody = existsSync(rulesSrc) ? readFileSync(rulesSrc, 'utf8') : '';
    writeFileSync(
      rulePath,
      `---\ndescription: "AgentRunlog Engineering Memory Rules"\nalwaysApply: true\n---\n\n${ruleBody}`,
      'utf8'
    );
    writtenPaths.push(rulePath);

    return { platform: 'cursor', success: true, paths: writtenPaths };
  }

  /**
   * 4. OpenAI Codex CLI Global Setup (~/.codex/config.toml, ~/.codex/hooks.json, ~/.codex/AGENTS.md)
   */
  public installCodex(): PlatformInstallResult {
    const codexDir = join(this.home, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const writtenPaths: string[] = [];

    // 4A. Hooks in ~/.codex/hooks.json
    const hooksPath = join(codexDir, 'hooks.json');
    let hooksData: Record<string, any> = { description: 'Codex CLI hooks', hooks: {} };
    if (existsSync(hooksPath)) {
      try {
        hooksData = JSON.parse(readFileSync(hooksPath, 'utf8'));
      } catch {}
    }
    hooksData.hooks = hooksData.hooks || {};

    const codexHookMap: Record<string, string> = {
      SessionStart: this.getHookCommand('codex', 'session-start'),
      UserPromptSubmit: this.getHookCommand('codex', 'prompt-submit'),
      PreToolUse: this.getHookCommand('codex', 'pre-tool-use'),
      PostToolUse: this.getHookCommand('codex', 'post-tool-use'),
      Stop: this.getHookCommand('codex', 'stop'),
    };

    for (const [event, cmd] of Object.entries(codexHookMap)) {
      const existing = Array.isArray(hooksData.hooks[event]) ? hooksData.hooks[event] : [];
      const filtered = existing.filter((entry: any) => {
        const entryStr = JSON.stringify(entry);
        return !entryStr.includes('agentrunlog') && !entryStr.includes('runlog hook');
      });
      filtered.push({ type: 'command', command: cmd });
      hooksData.hooks[event] = filtered;
    }

    writeFileSync(hooksPath, JSON.stringify(hooksData, null, 2), 'utf8');
    writtenPaths.push(hooksPath);

    // 4B. config.toml (MCP server + features.hooks = true)
    const configTomlPath = join(codexDir, 'config.toml');
    let toml = existsSync(configTomlPath) ? readFileSync(configTomlPath, 'utf8') : '';

    // Remove previous AgentRunlog managed block if present
    toml = toml.replace(/\n?# BEGIN AGENTRUNLOG MANAGED[\s\S]*?# END AGENTRUNLOG MANAGED\n?/g, '');

    const managedBlock = [
      '',
      '# BEGIN AGENTRUNLOG MANAGED',
      !toml.includes('hooks = true') ? '[features]\nhooks = true\n' : '',
      '[mcp_servers.agentrunlog]',
      `command = "${this.nodeExec.replace(/\\/g, '\\\\')}"`,
      `args = ["${this.cliEntry.replace(/\\/g, '\\\\')}", "mcp"]`,
      '# END AGENTRUNLOG MANAGED',
      '',
    ]
      .filter(Boolean)
      .join('\n');

    writeFileSync(configTomlPath, toml.trimEnd() + '\n' + managedBlock, 'utf8');
    writtenPaths.push(configTomlPath);

    // 4C. ~/.codex/AGENTS.md (idempotent marker block)
    const agentsMdPath = join(codexDir, 'AGENTS.md');
    let agentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : '';
    agentsMd = agentsMd.replace(/\n?<!-- AGENTRUNLOG_START -->[\s\S]*?<!-- AGENTRUNLOG_END -->\n?/g, '');

    const rulesSrc = join(this.pkgRoot, 'rules', 'AGENTS.md');
    const rulesContent = existsSync(rulesSrc) ? readFileSync(rulesSrc, 'utf8') : '';
    const wrappedRules = `\n<!-- AGENTRUNLOG_START -->\n${rulesContent.trim()}\n<!-- AGENTRUNLOG_END -->\n`;

    writeFileSync(agentsMdPath, (agentsMd.trim() + wrappedRules).trimStart(), 'utf8');
    writtenPaths.push(agentsMdPath);

    return { platform: 'codex', success: true, paths: writtenPaths };
  }
}
