import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { UniversalPluginInstaller } from './plugin-installer.js';
import { SystemDoctor } from './doctor.js';

describe('UniversalPluginInstaller & SystemDoctor (All 4 Platforms)', () => {
  let fakeHome: string;
  let pkgRoot: string;

  beforeEach(() => {
    fakeHome = join(tmpdir(), `agentrunlog_home_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(fakeHome, { recursive: true });
    pkgRoot = resolve(process.cwd());
  });

  afterEach(() => {
    if (existsSync(fakeHome)) {
      try {
        rmSync(fakeHome, { recursive: true, force: true });
      } catch {}
    }
  });

  it('installs plugins cleanly across Antigravity, Claude Code, Cursor, and Codex without overwriting user configs', () => {
    // Pre-populate existing user configs to verify non-destructive merging
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.claude.json'),
      JSON.stringify({ mcpServers: { existingServer: { command: 'echo' } }, customSetting: true }),
      'utf8'
    );
    mkdirSync(join(fakeHome, '.cursor'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { otherTool: { command: 'ls' } } }),
      'utf8'
    );
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'config.toml'), 'model = "gpt-5"\n', 'utf8');

    const installer = new UniversalPluginInstaller({
      homeDir: fakeHome,
      pkgRoot,
    });

    const results = installer.installAll();
    expect(results.length).toBe(4);
    expect(results.every((r) => r.success)).toBe(true);

    // Verify existing user keys were preserved!
    const claudeJson = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'));
    expect(claudeJson.customSetting).toBe(true);
    expect(claudeJson.mcpServers.existingServer).toBeDefined();
    expect(claudeJson.mcpServers.agentrunlog).toBeDefined();

    const cursorMcp = JSON.parse(readFileSync(join(fakeHome, '.cursor', 'mcp.json'), 'utf8'));
    expect(cursorMcp.mcpServers.otherTool).toBeDefined();
    expect(cursorMcp.mcpServers.agentrunlog).toBeDefined();

    const codexToml = readFileSync(join(fakeHome, '.codex', 'config.toml'), 'utf8');
    expect(codexToml).toContain('model = "gpt-5"');
    expect(codexToml).toContain('[mcp_servers.agentrunlog]');
    expect(codexToml).toContain('hooks = true');
  });

  it('SystemDoctor verifies all 4 installed platforms and live MCP handshake', async () => {
    const installer = new UniversalPluginInstaller({
      homeDir: fakeHome,
      pkgRoot,
    });
    installer.installAll();

    const doctor = new SystemDoctor(fakeHome, resolve(pkgRoot, 'dist/cli/index.js'));
    const report = await doctor.runAllChecks();

    expect(report.allHealthy).toBe(true);
    expect(report.checks.length).toBe(6);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });
});

describe('ensureCodexHooksFeature', () => {
  it('never creates a duplicate [features] table', async () => {
    const { ensureCodexHooksFeature } = await import('./plugin-installer.js');
    const existing = 'model = "x"\n\n[features]\nfoo = true\n\n[mcp_servers.a]\ncommand = "a"\n';
    const out = ensureCodexHooksFeature(existing);
    expect(out.match(/\[features\]/g)).toHaveLength(1);
    expect(out).toContain('[features]\nhooks = true\nfoo = true');
    expect(ensureCodexHooksFeature(out)).toBe(out); // idempotent
    expect(ensureCodexHooksFeature('[features]\nhooks = false\n')).toBe('[features]\nhooks = false\n'); // user value wins
    expect(ensureCodexHooksFeature('model = "x"\n')).toContain('[features]\nhooks = true');
  });

});

describe('MCP entry selection', () => {
  it('registers the self-contained bundle (not dist) as the MCP server entry on every platform', () => {
    const home = join(tmpdir(), `agentrunlog_mcp_${Date.now()}`);
    mkdirSync(home, { recursive: true });
    const root = join(home, 'pkg');
    mkdirSync(join(root, 'bundle'), { recursive: true });
    writeFileSync(join(root, 'bundle', 'agentrunlog.mjs'), '// stub');
    writeFileSync(join(root, 'package.json'), '{"name":"agentrunlog"}');
    const bundle = join(root, 'bundle', 'agentrunlog.mjs');
    new UniversalPluginInstaller({ homeDir: home, pkgRoot: root }).installAll();
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers.agentrunlog.args[0]).toBe(bundle);
    expect(JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentrunlog.args[0]).toBe(bundle);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain(bundle);
  });
});
