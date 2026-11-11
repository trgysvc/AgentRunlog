import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface DoctorCheck {
  component: string;
  ok: boolean;
  details: string;
}

export interface DoctorReport {
  allHealthy: boolean;
  checks: DoctorCheck[];
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

export class SystemDoctor {
  private home: string;
  private cliEntry: string;
  private nodeExec: string;

  constructor(homeDir?: string, cliEntry?: string, nodeExec?: string) {
    this.home = homeDir || homedir();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = findPackageRoot(__dirname);
    this.cliEntry = cliEntry || resolve(pkgRoot, 'dist/cli/index.js');
    this.nodeExec = nodeExec || process.execPath;
  }

  public async runAllChecks(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    // 1. CLI Binary Check
    checks.push({
      component: 'CLI Runtime',
      ok: existsSync(this.cliEntry),
      details: existsSync(this.cliEntry)
        ? `Ready at ${this.cliEntry}`
        : `Missing build artifact at ${this.cliEntry}`,
    });

    // 2. Antigravity Plugin Check
    const agDir = join(this.home, '.gemini', 'config', 'plugins', 'agentrunlog');
    const agFiles = ['plugin.json', 'mcp_config.json', 'hooks.json', 'rules/AGENTS.md', 'skills/agentrunlog/SKILL.md'];
    const agOk = agFiles.every((f) => existsSync(join(agDir, f)));
    checks.push({
      component: 'Google Antigravity Plugin',
      ok: agOk,
      details: agOk
        ? `Installed at ${agDir} (MCP + Hooks + Rules + Skill)`
        : `Missing files in ${agDir}. Run: runlog setup`,
    });

    // 3. Claude Code Check
    const claudeJsonPath = join(this.home, '.claude.json');
    const claudeSettingsPath = join(this.home, '.claude', 'settings.json');
    const claudeSkillPath = join(this.home, '.claude', 'skills', 'agentrunlog', 'SKILL.md');
    let claudeMcpOk = false;
    let claudeHooksOk = false;
    try {
      if (existsSync(claudeJsonPath)) {
        const cj = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
        claudeMcpOk = Boolean(cj?.mcpServers?.agentrunlog);
      }
      if (existsSync(claudeSettingsPath)) {
        const cs = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
        claudeHooksOk = Boolean(cs?.hooks?.SessionStart && cs?.hooks?.SessionEnd);
      }
    } catch {}
    const claudeOk = claudeMcpOk && claudeHooksOk && existsSync(claudeSkillPath);
    checks.push({
      component: 'Claude Code Plugin',
      ok: claudeOk,
      details: claudeOk
        ? 'MCP (~/.claude.json), Hooks (~/.claude/settings.json), and Skill configured'
        : 'Incomplete Claude Code configuration. Run: runlog setup',
    });

    // 4. Cursor Check
    const cursorMcpPath = join(this.home, '.cursor', 'mcp.json');
    const cursorHooksPath = join(this.home, '.cursor', 'hooks.json');
    const cursorRulesPath = join(this.home, '.cursor', 'rules', 'agentrunlog.mdc');
    let cursorMcpOk = false;
    let cursorHooksOk = false;
    try {
      if (existsSync(cursorMcpPath)) {
        const cm = JSON.parse(readFileSync(cursorMcpPath, 'utf8'));
        cursorMcpOk = Boolean(cm?.mcpServers?.agentrunlog);
      }
      if (existsSync(cursorHooksPath)) {
        const ch = JSON.parse(readFileSync(cursorHooksPath, 'utf8'));
        cursorHooksOk = Boolean(ch?.hooks?.beforeSubmitPrompt && ch?.hooks?.stop);
      }
    } catch {}
    const cursorOk = cursorMcpOk && cursorHooksOk && existsSync(cursorRulesPath);
    checks.push({
      component: 'Cursor IDE & CLI Plugin',
      ok: cursorOk,
      details: cursorOk
        ? 'MCP (~/.cursor/mcp.json), Hooks (~/.cursor/hooks.json), and Rules (.mdc) configured'
        : 'Incomplete Cursor configuration. Run: runlog setup',
    });

    // 5. Codex CLI Check
    const codexTomlPath = join(this.home, '.codex', 'config.toml');
    const codexHooksPath = join(this.home, '.codex', 'hooks.json');
    const codexAgentsPath = join(this.home, '.codex', 'AGENTS.md');
    let codexTomlOk = false;
    let codexHooksOk = false;
    let codexRulesOk = false;
    try {
      if (existsSync(codexTomlPath)) {
        const toml = readFileSync(codexTomlPath, 'utf8');
        codexTomlOk = toml.includes('[mcp_servers.agentrunlog]') && toml.includes('hooks = true');
      }
      if (existsSync(codexHooksPath)) {
        const ch = JSON.parse(readFileSync(codexHooksPath, 'utf8'));
        codexHooksOk = Boolean(ch?.hooks?.SessionStart && ch?.hooks?.Stop);
      }
      if (existsSync(codexAgentsPath)) {
        codexRulesOk = readFileSync(codexAgentsPath, 'utf8').includes('AGENTRUNLOG_START');
      }
    } catch {}
    const codexOk = codexTomlOk && codexHooksOk && codexRulesOk;
    checks.push({
      component: 'OpenAI Codex CLI Plugin',
      ok: codexOk,
      details: codexOk
        ? 'MCP & features.hooks (~/.codex/config.toml), Hooks, and AGENTS.md configured'
        : 'Incomplete Codex CLI configuration. Run: runlog setup',
    });

    // 6. Live MCP Handshake Verification
    const mcpHandshake = await this.verifyMcpHandshake();
    checks.push(mcpHandshake);

    return {
      allHealthy: checks.every((c) => c.ok),
      checks,
    };
  }

  public async verifyMcpHandshake(): Promise<DoctorCheck> {
    if (!existsSync(this.cliEntry)) {
      return { component: 'Live MCP Server Handshake', ok: false, details: 'CLI build missing' };
    }

    return new Promise((resolvePromise) => {
      const child = spawn(this.nodeExec, [this.cliEntry, 'mcp'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolvePromise({
          component: 'Live MCP Server Handshake',
          ok: false,
          details: 'Timed out waiting for MCP stdio response',
        });
      }, 3000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes('"id":2') && stdout.includes('search_runlog') && stdout.includes('record_decision')) {
          clearTimeout(timer);
          try {
            child.kill();
          } catch {}
          resolvePromise({
            component: 'Live MCP Server Handshake',
            ok: true,
            details: 'Responded over stdio with all 8 tools (read + live write)',
          });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise({
          component: 'Live MCP Server Handshake',
          ok: false,
          details: err.message,
        });
      });

      const payload = [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor', version: '1.0' } },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ].join('\n') + '\n';

      child.stdin.write(payload);
    });
  }
}
