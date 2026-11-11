#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StorageManager } from '../storage/index.js';
import { WikiLinter } from '../compiler/linter.js';
import { WikiReindexer } from '../compiler/reindex.js';
import { TranscriptExtractor } from '../compiler/extractor.js';
import { CodebaseScanner } from '../compiler/scanner.js';
import { HookManager } from '../hooks/index.js';
import { createRunlogMcpServer } from '../mcp/server.js';
import { existsSync, readFileSync, appendFileSync, readdirSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
AgentRunlog CLI — Typed Engineering Memory for Coding Agents

Usage:
  runlog install-plugin <plt> Install native plugin bundle (antigravity | claude | cursor | codex)
  runlog init [platform]      Initialize memory, scan existing codebase, and install project hooks
  runlog scan                 Scan existing codebase (stack, git log, modules, docs) into memory
  runlog compile [session]    Extract typed knowledge from session transcripts using compiler
  runlog status               Display memory statistics and active context cache size
  runlog lint                 Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex              Rebuild wiki and cache from raw transcripts (NFR-10)
  runlog mcp                  Start Model Context Protocol (MCP) server over stdio
  runlog hook <plt> <evt>     Execute platform hook event with stdin capture (< 20ms SLA)
`);
    return;
  }

  if (command === 'install-plugin') {
    const targetPlatform = (args[1] || 'antigravity').toLowerCase();
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgRoot = resolve(__dirname, '../..');
    const cliEntry = resolve(pkgRoot, 'dist/cli/index.js');
    const nodeExec = process.execPath;

    if (targetPlatform === 'antigravity') {
      const pluginDir = join(homedir(), '.gemini', 'config', 'plugins', 'agentrunlog');
      const rulesDir = join(pluginDir, 'rules');
      const skillsDir = join(pluginDir, 'skills', 'agentrunlog');
      mkdirSync(rulesDir, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });

      // Copy plugin.json, rules/AGENTS.md, skills/agentrunlog/SKILL.md
      for (const rel of ['plugin.json', 'rules/AGENTS.md', 'skills/agentrunlog/SKILL.md']) {
        const srcPath = join(pkgRoot, rel);
        const destPath = join(pluginDir, rel);
        if (existsSync(srcPath)) copyFileSync(srcPath, destPath);
      }

      // Write mcp_config.json with absolute node + cli path for reliable GUI execution
      writeFileSync(
        join(pluginDir, 'mcp_config.json'),
        JSON.stringify(
          {
            mcpServers: {
              agentrunlog: {
                command: nodeExec,
                args: [cliEntry, 'mcp'],
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Write hooks.json with absolute node + cli path
      writeFileSync(
        join(pluginDir, 'hooks.json'),
        JSON.stringify(
          {
            description: 'AgentRunlog typed engineering memory hooks for Google Antigravity',
            hooks: {
              PreInvocation: [{ type: 'command', command: `${nodeExec} ${cliEntry} hook antigravity pre-invocation` }],
              PostInvocation: [{ type: 'command', command: `${nodeExec} ${cliEntry} hook antigravity post-invocation` }],
              PostToolUse: [{ type: 'command', command: `${nodeExec} ${cliEntry} hook antigravity post-tool-use` }],
              Stop: [{ type: 'command', command: `${nodeExec} ${cliEntry} hook antigravity stop` }],
            },
          },
          null,
          2
        ),
        'utf8'
      );

      // Remove standalone agentrunlog entry from ~/.gemini/config/mcp_config.json to avoid global collision
      const userMcpPath = join(homedir(), '.gemini', 'config', 'mcp_config.json');
      if (existsSync(userMcpPath)) {
        try {
          const userMcp = JSON.parse(readFileSync(userMcpPath, 'utf8'));
          if (userMcp?.mcpServers?.agentrunlog) {
            delete userMcp.mcpServers.agentrunlog;
            writeFileSync(userMcpPath, JSON.stringify(userMcp, null, 2), 'utf8');
          }
        } catch {}
      }

      console.log(`✅ Installed AgentRunlog native Antigravity plugin to:\n   ${pluginDir}`);
      console.log(`   Includes: plugin.json, mcp_config.json, hooks.json, rules/AGENTS.md, skills/agentrunlog/SKILL.md`);
      console.log(`\n🚀 Next step: Run "runlog init" in any project directory to initialize .agentrunlog/`);
    } else if (targetPlatform === 'claude') {
      console.log(`ℹ️ To install as a Claude Code plugin directly from GitHub:`);
      console.log(`   claude plugin add https://github.com/trgysvc/AgentRunlog.git`);
      console.log(`   Or inside any project: runlog init claude`);
    } else {
      console.log(`ℹ️ Run "runlog init ${targetPlatform}" inside your project directory to configure hooks & rules.`);
    }
    return;
  }

  const storage = new StorageManager();
  const hooks = new HookManager(storage);

  switch (command) {
    case 'init': {
      console.log('⚡ Initializing AgentRunlog in current project...');

      // 1. Ensure storage directories
      console.log(`📁 Memory storage: ${storage.paths.root}`);

      // 2. Install platform hooks
      const rawArg = args[1]?.toLowerCase();
      const platformArg = rawArg && !rawArg.startsWith('--') ? rawArg : undefined;
      if (!platformArg || platformArg === 'all') {
        hooks.installAll();
        console.log('✅ Installed hooks for Claude Code (.claude/hooks.json)');
        console.log('✅ Installed hooks for Google Antigravity (.agents/hooks.json)');
        console.log('✅ Installed hooks & rules for Cursor (.cursor/hooks.json & .cursorrules)');
        console.log('✅ Installed hooks for Codex CLI (.codex/hooks.json)');
      } else if (platformArg === 'claude') {
        hooks.claude.install();
        console.log('✅ Installed Claude Code hook (.claude/hooks.json)');
      } else if (platformArg === 'antigravity') {
        hooks.antigravity.install();
        console.log('✅ Installed Google Antigravity hook (.agents/hooks.json)');
      } else if (platformArg === 'cursor') {
        hooks.cursor.install();
        console.log('✅ Installed Cursor hooks & rules (.cursor/hooks.json & .cursorrules)');
      } else if (platformArg === 'codex') {
        hooks.codex.install();
        console.log('✅ Installed Codex CLI hook (.codex/hooks.json)');
      }

      // 3. Ensure .agentrunlog/raw/ is in .gitignore
      const gitignorePath = join(process.cwd(), '.gitignore');
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf8');
        if (!content.includes('.agentrunlog/raw/')) {
          appendFileSync(gitignorePath, '\n# AgentRunlog Raw Transcripts (Privacy Protected)\n.agentrunlog/raw/\n');
          console.log('🔒 Added .agentrunlog/raw/ to .gitignore');
        }
      }

      // 4. Bootstrap existing codebase memory unless --no-scan is provided
      if (!args.includes('--no-scan')) {
        console.log('🔎 Scanning existing codebase to bootstrap initial engineering memory...');
        const scanner = new CodebaseScanner(storage, process.cwd());
        const scanRes = scanner.scan();
        console.log(`   - Detected Stack(s): ${scanRes.detectedStacks.join(', ') || 'Generic'}`);
        console.log(`   - Indexed Modules:   ${scanRes.indexedModules.length}`);
        console.log(`   - Decisions Created: ${scanRes.decisionsCreated}`);
        console.log(`   - Historical RCAs:   ${scanRes.rcasCreated}`);
      }

      console.log('\n🎉 AgentRunlog initialized successfully! Your coding agents now retain persistent memory.');
      break;
    }

    case 'scan': {
      console.log('🔎 Scanning existing codebase (Tech Stack, Modules, Docs, Git History)...');
      const scanner = new CodebaseScanner(storage, process.cwd());
      const res = scanner.scan();
      console.log(`✅ Scan completed in ${res.durationMs}ms:`);
      console.log(`   - Tech Stacks:       ${res.detectedStacks.join(', ') || 'None detected'}`);
      console.log(`   - Indexed Modules:   ${res.indexedModules.length}`);
      console.log(`   - Decisions Saved:   ${res.decisionsCreated}`);
      console.log(`   - Historical RCAs:   ${res.rcasCreated}`);
      console.log(`   - Activity Tasks:    ${res.tasksCreated}`);
      break;
    }

    case 'compile': {
      console.log('⚙️ Running AgentRunlog Compiler Worker...');
      const targetSession = args[1];
      const extractor = new TranscriptExtractor(storage, storage.config.compiler as any);

      let filesToCompile: string[] = [];

      if (targetSession && existsSync(targetSession)) {
        filesToCompile = [targetSession];
      } else if (existsSync(storage.paths.raw)) {
        filesToCompile = readdirSync(storage.paths.raw)
          .filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
          .map((f) => join(storage.paths.raw, f));
      }

      if (filesToCompile.length === 0) {
        console.log('ℹ️ No raw session transcripts found to compile.');
        break;
      }

      let totalDecisions = 0;
      let totalRcas = 0;
      let totalDeadEnds = 0;

      for (const file of filesToCompile) {
        console.log(`📄 Compiling session: ${file}...`);
        const bundle = await extractor.extractAndCompile(file);
        totalDecisions += bundle.decisions.length;
        totalRcas += bundle.rcas.length;
        totalDeadEnds += bundle.deadEnds.length;
      }

      console.log(`\n✨ Compilation complete:`);
      console.log(`   - Decisions extracted: ${totalDecisions}`);
      console.log(`   - RCAs extracted:      ${totalRcas}`);
      console.log(`   - DeadEnds logged:     ${totalDeadEnds}`);
      console.log(`   - Wiki Index:          ${storage.paths.wikiIndex}`);
      break;
    }

    case 'status': {
      const decisions = storage.wiki.listDecisions();
      const rcas = storage.wiki.listRCAs();
      const deadEnds = storage.wiki.listDeadEnds();
      const activeContext = storage.cache.getActiveContext();

      console.log('🧠 AgentRunlog Status Overview:');
      console.log(`───────────────────────────────────────────`);
      console.log(`  Decisions (Active):     ${decisions.filter((d) => d.status === 'active').length}`);
      console.log(`  Decisions (Superseded): ${decisions.filter((d) => d.status === 'superseded').length}`);
      console.log(`  Root Cause Analyses:    ${rcas.length}`);
      console.log(`  Known Dead Ends:        ${deadEnds.length}`);
      console.log(`  Active Context Tokens:  ~${activeContext?.estimatedTokens || 0} / 800 limit`);
      console.log(`  Last Cache Update:      ${activeContext?.lastUpdated || 'Never'}`);
      console.log(`───────────────────────────────────────────`);
      break;
    }

    case 'lint': {
      console.log('🔍 Running AgentRunlog Wiki Health Check (FR-11)...');
      const linter = new WikiLinter(storage);
      const report = linter.lint();

      console.log(`Total Records Audited: ${report.totalRecords}`);
      console.log(`Errors: ${report.issueCount.errors} | Warnings: ${report.issueCount.warnings} | Info: ${report.issueCount.info}\n`);

      if (report.issues.length === 0) {
        console.log('✨ All engineering memory records are consistent and healthy! No contradictions found.');
      } else {
        for (const issue of report.issues) {
          const tag = issue.severity === 'error' ? '❌ ERROR' : issue.severity === 'warning' ? '⚠️ WARN' : 'ℹ️ INFO';
          console.log(`${tag} [${issue.code}] (${issue.recordType} ${issue.recordId}): ${issue.message}`);
        }
      }
      break;
    }

    case 'reindex': {
      console.log('🔄 Re-indexing knowledge base from raw transcripts (NFR-10)...');
      const reindexer = new WikiReindexer(storage);
      const res = reindexer.reindex();
      console.log(`✅ Processed ${res.processedSessions} session(s) in ${res.durationMs}ms.`);
      console.log('✨ Memory cache and wiki index updated successfully.');
      break;
    }

    case 'mcp': {
      const { server } = createRunlogMcpServer(storage);
      const transport = new StdioServerTransport();
      await server.connect(transport);
      break;
    }

    case 'hook': {
      const platform = args[1] || 'claude';
      const event = args[2] || 'session-start';
      const sessionId = args[3];

      const pushText = await hooks.runner.runHook({
        platform,
        event,
        sessionId,
        cliPath: process.argv[1],
      });

      if (pushText) {
        process.stdout.write(pushText + '\n');
      }
      break;
    }

    default:
      console.log(`
AgentRunlog CLI — Typed Engineering Memory for Coding Agents

Usage:
  runlog init [platform]    Initialize memory and install hooks (claude | antigravity | cursor | codex | all)
  runlog compile [session]  Extract typed knowledge from session transcripts using LLM compiler
  runlog status             Display memory statistics and active context cache size
  runlog lint               Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex            Rebuild wiki and cache from raw transcripts (NFR-10)
  runlog mcp                Start Model Context Protocol (MCP) server over stdio
  runlog hook <plt> <evt>   Execute platform hook event with stdin capture (< 20ms SLA)
`);
      break;
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
