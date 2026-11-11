#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StorageManager } from '../storage/index.js';
import { WikiLinter } from '../compiler/linter.js';
import { WikiReindexer } from '../compiler/reindex.js';
import { TranscriptExtractor } from '../compiler/extractor.js';
import { CodebaseScanner } from '../compiler/scanner.js';
import { HistoryImporter } from '../compiler/history-importer.js';
import { ensureProjectBootstrapped, isValidProjectDirectory } from '../compiler/auto-bootstrap.js';
import { HookManager } from '../hooks/index.js';
import { createRunlogMcpServer } from '../mcp/server.js';
import { UniversalPluginInstaller, SystemDoctor } from '../installer/index.js';
import { existsSync, readFileSync, appendFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
AgentRunlog CLI — Typed Engineering Memory for Coding Agents

Usage:
  runlog setup                Install plugins across ALL 4 platforms & run full verification
  runlog install-plugin [plt] Install plugin (all | antigravity | claude | cursor | codex)
  runlog doctor               Verify all 4 platform plugins + live MCP JSON-RPC handshake
  runlog init [platform]      Initialize memory, scan codebase + history, and install project hooks
  runlog scan [--alias name]  Scan existing codebase + past conversations across all 4 platforms
  runlog compile [session]    Extract typed knowledge from session transcripts using compiler
  runlog status               Display memory statistics and active context cache size
  runlog lint                 Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex              Rebuild wiki and cache from raw transcripts (NFR-10)
  runlog mcp                  Start Model Context Protocol (MCP) server over stdio
  runlog hook <plt> <evt>     Execute platform hook event with stdin capture (< 20ms SLA)
`);
    return;
  }

  if (command === 'setup' || command === 'install-plugin') {
    const target = command === 'setup' ? 'all' : (args[1] || 'all').toLowerCase();
    const installer = new UniversalPluginInstaller();

    console.log('🔌 Installing AgentRunlog Plugin Bundle...');
    let results;
    if (target === 'all') {
      results = installer.installAll();
    } else if (target === 'antigravity') {
      results = [installer.installAntigravity()];
    } else if (target === 'claude') {
      results = [installer.installClaudeCode()];
    } else if (target === 'cursor') {
      results = [installer.installCursor()];
    } else if (target === 'codex') {
      results = [installer.installCodex()];
    } else {
      console.error(`❌ Unknown platform: ${target}. Use: all | antigravity | claude | cursor | codex`);
      process.exit(1);
    }

    for (const res of results) {
      console.log(`✅ ${res.platform.toUpperCase()}: Configured (${res.paths.length} files)`);
      for (const p of res.paths) {
        console.log(`   - ${p}`);
      }
    }

    if (command === 'setup' || target === 'all') {
      console.log('\n🩺 Running System Verification (runlog doctor)...');
      const doctor = new SystemDoctor();
      const report = await doctor.runAllChecks();
      for (const chk of report.checks) {
        console.log(`${chk.ok ? '✅' : '❌'} ${chk.component}: ${chk.details}`);
      }
      if (!report.allHealthy) {
        console.warn('\n⚠️ Some checks failed. Please review the messages above.');
        process.exit(1);
      }
      console.log('\n🎉 All 4 platforms installed and verified! Run "runlog init" inside any project to start.');
    }
    return;
  }

  if (command === 'doctor') {
    console.log('🩺 Running AgentRunlog Diagnostic & Live Verification...\n');
    const doctor = new SystemDoctor();
    const report = await doctor.runAllChecks();
    for (const chk of report.checks) {
      console.log(`${chk.ok ? '✅' : '❌'} ${chk.component}: ${chk.details}`);
    }
    console.log('');
    if (report.allHealthy) {
      console.log('✨ All 4 platforms and live MCP server are healthy and ready!');
    } else {
      console.log('⚠️ Some checks failed. Run "runlog setup" to auto-repair.');
      process.exit(1);
    }
    return;
  }

  if (command === 'postinstall') {
    // Only auto-configure all 4 platforms on global install (npm install -g ...)
    if (process.env.npm_config_global === 'true') {
      try {
        const installer = new UniversalPluginInstaller();
        installer.installAll();
        console.log('⚡ AgentRunlog: Automatically configured plugins for Antigravity, Claude Code, Cursor, and Codex CLI.');
      } catch {}
    }
    return;
  }

  if (command === 'bootstrap') {
    if (isValidProjectDirectory(process.cwd())) {
      await ensureProjectBootstrapped(process.cwd());
    }
    return;
  }

  if (command === 'mcp') {
    const { server } = createRunlogMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (command === 'hook') {
    if (!isValidProjectDirectory(process.cwd())) {
      return;
    }
    const hookStorage = new StorageManager();
    const hookManager = new HookManager(hookStorage);
    const platform = args[1] || 'claude';
    const event = args[2] || 'session-start';
    const sessionId = args[3];

    const pushText = await hookManager.runner.runHook({
      platform,
      event,
      sessionId,
      cliPath: process.argv[1],
    });

    if (pushText) {
      process.stdout.write(pushText + '\n');
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

      // 4. Bootstrap existing codebase memory & past agent conversations unless --no-scan is provided
      if (!args.includes('--no-scan')) {
        console.log('🔎 Scanning existing codebase to bootstrap initial engineering memory...');
        const scanner = new CodebaseScanner(storage, process.cwd());
        const scanRes = scanner.scan();
        console.log(`   - Detected Stack(s): ${scanRes.detectedStacks.join(', ') || 'Generic'}`);
        console.log(`   - Indexed Modules:   ${scanRes.indexedModules.length}`);
        console.log(`   - Decisions Created: ${scanRes.decisionsCreated}`);
        console.log(`   - Historical RCAs:   ${scanRes.rcasCreated}`);

        console.log('📜 Importing past agent conversations (Antigravity / Claude / Codex / Cursor)...');
        const importer = new HistoryImporter(storage, process.cwd());
        const importRes = await importer.importProjectHistory();
        console.log(`   - Antigravity sessions: ${importRes.antigravitySessionsImported}`);
        console.log(`   - Claude Code sessions: ${importRes.claudeSessionsImported}`);
        console.log(`   - Codex CLI sessions:   ${importRes.codexSessionsImported}`);
        console.log(`   - Cursor sessions:      ${importRes.cursorSessionsImported}`);
        console.log(`   - Events imported:      ${importRes.totalEventsImported}`);

        if (importRes.importedFiles.length > 0) {
          const extractor = new TranscriptExtractor(storage, storage.config.compiler as any);
          for (const f of importRes.importedFiles) {
            await extractor.extractAndCompile(join(storage.paths.raw, f));
          }
          console.log('✨ Compiled imported conversations into wiki memory.');
        }
        writeFileSync(join(storage.paths.cache, 'bootstrap.done'), new Date().toISOString(), 'utf8');
      }

      console.log('\n🎉 AgentRunlog initialized successfully! Your coding agents now retain persistent memory.');
      break;
    }

    case 'scan': {
      console.log('🔎 Scanning existing codebase & past agent conversations...');
      const aliasIdx = args.indexOf('--alias');
      const aliases = aliasIdx !== -1 && args[aliasIdx + 1] ? args[aliasIdx + 1].split(',') : undefined;

      const scanner = new CodebaseScanner(storage, process.cwd());
      const res = scanner.scan();
      console.log(`✅ Codebase scan completed in ${res.durationMs}ms:`);
      console.log(`   - Tech Stacks:       ${res.detectedStacks.join(', ') || 'None detected'}`);
      console.log(`   - Indexed Modules:   ${res.indexedModules.length}`);
      console.log(`   - Decisions Saved:   ${res.decisionsCreated}`);
      console.log(`   - Historical RCAs:   ${res.rcasCreated}`);

      const importer = new HistoryImporter(storage, process.cwd());
      const importRes = await importer.importProjectHistory({ aliases });
      console.log(`📜 Past conversations imported (All 4 Platforms):`);
      console.log(`   - Antigravity sessions: ${importRes.antigravitySessionsImported}`);
      console.log(`   - Claude Code sessions: ${importRes.claudeSessionsImported}`);
      console.log(`   - Codex CLI sessions:   ${importRes.codexSessionsImported}`);
      console.log(`   - Cursor sessions:      ${importRes.cursorSessionsImported}`);
      console.log(`   - Total events:         ${importRes.totalEventsImported}`);

      if (importRes.importedFiles.length > 0) {
        const extractor = new TranscriptExtractor(storage, storage.config.compiler as any);
        for (const f of importRes.importedFiles) {
          await extractor.extractAndCompile(join(storage.paths.raw, f));
        }
        console.log('✨ Compiled all imported transcripts into wiki & active_context.json!');
      }
      writeFileSync(join(storage.paths.cache, 'bootstrap.done'), new Date().toISOString(), 'utf8');
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

    default:
      console.log(`
AgentRunlog CLI — Typed Engineering Memory for Coding Agents

Usage:
  runlog setup                Install plugins across ALL 4 platforms & run full verification
  runlog doctor               Verify all 4 platform plugins + live MCP JSON-RPC handshake
  runlog init [platform]      Initialize memory, scan codebase + history, and install project hooks
  runlog scan [--alias name]  Scan existing codebase + past conversations across all 4 platforms
  runlog compile [session]    Extract typed knowledge from session transcripts using compiler
  runlog status               Display memory statistics and active context cache size
  runlog lint                 Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex              Rebuild wiki and cache from raw transcripts (NFR-10)
`);
      break;
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
