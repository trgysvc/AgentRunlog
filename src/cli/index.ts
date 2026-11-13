#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StorageManager } from '../storage/index.js';
import { buildImpactReport } from '../compiler/report.js';
import { WikiLinter } from '../compiler/linter.js';
import { WikiReindexer } from '../compiler/reindex.js';
import { TranscriptExtractor } from '../compiler/extractor.js';
import { CodebaseScanner } from '../compiler/scanner.js';
import { HistoryImporter } from '../compiler/history-importer.js';
import { IMPORT_VERSION } from '../compiler/import-version.js';
import { ensureProjectBootstrapped, isValidProjectDirectory } from '../compiler/auto-bootstrap.js';
import { HookManager } from '../hooks/index.js';
import { formatHookOutput } from '../hooks/light.js';
import { createRunlogMcpServer } from '../mcp/server.js';
import { UniversalPluginInstaller, SystemDoctor } from '../installer/index.js';
import { existsSync, readFileSync, appendFileSync, readdirSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { formatBytes, storageUsage } from '../storage/usage.js';
import { acquireLock } from '../storage/lock.js';
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
  runlog scan [--alias name] [--force]
                              Scan codebase + past conversations across all 4 platforms
                              (--force re-imports every conversation, ignoring the unchanged-file cache)
  runlog compile [session]    Extract typed knowledge from session transcripts using compiler
  runlog status               Display memory statistics and active context cache size
  runlog pause | resume       Stop / resume recording in this project (NFR-03 opt-out)
  runlog usage                Show how much disk space AgentRunlog uses (per folder)
  runlog report               Impact report: sessions, injections, records, repeated failures
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
      const bsStorage = new StorageManager();
      const releaseBootstrap = acquireLock(join(bsStorage.paths.cache, 'bootstrap.lock'));
      if (!releaseBootstrap) return; // another bootstrap worker is already running
      try {
        await ensureProjectBootstrapped(process.cwd());
      } finally {
        releaseBootstrap();
      }
    }
    return;
  }

  if (command === 'pause' || command === 'resume') {
    const st = new StorageManager();
    const flag = join(st.paths.cache, 'paused');
    mkdirSync(st.paths.cache, { recursive: true });
    if (command === 'pause') writeFileSync(flag, new Date().toISOString());
    else rmSync(flag, { force: true });
    console.log(command === 'pause' ? '⏸  Recording paused: hooks capture nothing until `runlog resume`.' : '▶️  Recording resumed.');
    process.exit(0);
  }

  if (command === 'usage') {
    const st = new StorageManager();
    const u = storageUsage(st.paths.root);
    console.log(`AgentRunlog disk usage — ${st.paths.root}\n`);
    for (const e of u.entries) console.log(`  ${e.name.padEnd(14)} ${formatBytes(e.bytes).padStart(10)}  (${e.files} files)`);
    console.log(`\n  ${'TOTAL'.padEnd(14)} ${formatBytes(u.total).padStart(10)}`);
    const raw = u.entries.find((e) => e.name === 'raw/');
    if (raw && raw.bytes > u.total * 0.5) console.log('\n  raw/ holds the full conversation copies (git-ignored). Originals stay in each platform.');
    return;
  }

  if (command === 'sync-history') {
    // Detached background worker started by the SessionStart hook: incremental, never touches originals.
    if (isValidProjectDirectory(process.cwd())) {
      const st = new StorageManager();
      const release = acquireLock(join(st.paths.cache, 'history.lock'));
      if (!release) return;
      try {
        const res = await new HistoryImporter(st, process.cwd()).importProjectHistory();
        const releaseCompile = res.importedFiles.length > 0 ? acquireLock(join(st.paths.cache, 'compile.lock')) : null;
        if (releaseCompile) {
          try {
            const extractor = new TranscriptExtractor(st, st.config.compiler as any);
            for (const f of res.importedFiles) await extractor.extractAndCompile(join(st.paths.raw, f));
          } finally {
            releaseCompile();
          }
        }
        writeFileSync(join(st.paths.cache, 'history_sync.json'), JSON.stringify({ at: Date.now(), version: IMPORT_VERSION }), 'utf8');
      } finally {
        release();
      }
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
    const pushText = await hookManager.runner.runHook({
      platform: args[1] || 'claude',
      event: args[2] || 'session-start',
      sessionId: args[3],
      cliPath: process.argv[1],
    });

    const out = formatHookOutput(args[1] || 'claude', args[2] || 'session-start', pushText);
    if (out) process.stdout.write(out + '\n');
    process.exit(0);
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
        console.log('✅ Installed hooks for Claude Code (.claude/settings.json)');
        console.log('✅ Installed hooks for Google Antigravity (.agents/hooks.json)');
        console.log('✅ Installed hooks & rules for Cursor (.cursor/hooks.json & .cursor/rules/agentrunlog.mdc)');
        console.log('✅ Installed hooks for Codex CLI (.codex/hooks.json)');
      } else if (platformArg === 'claude') {
        hooks.claude.install();
        console.log('✅ Installed Claude Code hook (.claude/settings.json)');
      } else if (platformArg === 'antigravity') {
        hooks.antigravity.install();
        console.log('✅ Installed Google Antigravity hook (.agents/hooks.json)');
      } else if (platformArg === 'cursor') {
        hooks.cursor.install();
        console.log('✅ Installed Cursor hooks & rules (.cursor/hooks.json & .cursor/rules/agentrunlog.mdc)');
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
      const importRes = await importer.importProjectHistory({ aliases, force: args.includes('--force') });
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
      const releaseCompile = acquireLock(join(storage.paths.cache, 'compile.lock'));
      if (!releaseCompile) {
        console.log('ℹ️ Another compile worker is already running; skipping.');
        break;
      }
      try {
        console.log('⚙️ Running AgentRunlog Compiler Worker...');
        const targetSession = args[1];
        const extractor = new TranscriptExtractor(storage, storage.config.compiler as any);
        const statePath = join(storage.paths.cache, 'compiled.json');
        let compiledState: Record<string, number> = {};
        try {
          compiledState = JSON.parse(readFileSync(statePath, 'utf8'));
        } catch {}

        let filesToCompile: string[] = [];
        if (targetSession && existsSync(targetSession)) {
          filesToCompile = [targetSession];
        } else if (existsSync(storage.paths.raw)) {
          filesToCompile = readdirSync(storage.paths.raw)
            .filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
            .map((f) => join(storage.paths.raw, f));
        }

        // Reset the uncompiled-turn counter BEFORE reading, so turns logged meanwhile count again.
        try {
          writeFileSync(join(storage.paths.cache, 'pending.json'), JSON.stringify({ turns: 0 }), 'utf8');
        } catch {}

        // Incremental: only transcripts that grew since their last compile.
        const dirty = filesToCompile.filter((f) => {
          try {
            return targetSession ? true : statSync(f).size !== compiledState[f];
          } catch {
            return false;
          }
        });

        if (dirty.length === 0) {
          console.log('ℹ️ Nothing new to compile.');
          break;
        }

        let totalDecisions = 0;
        let totalRcas = 0;
        let totalDeadEnds = 0;
        for (const file of dirty) {
          console.log(`📄 Compiling session: ${file}...`);
          const sizeBefore = statSync(file).size;
          const bundle = await extractor.extractAndCompile(file);
          compiledState[file] = sizeBefore;
          totalDecisions += bundle.decisions.length;
          totalRcas += bundle.rcas.length;
          totalDeadEnds += bundle.deadEnds.length;
        }
        try {
          writeFileSync(statePath, JSON.stringify(compiledState), 'utf8');
        } catch {}

        console.log(`\n✨ Compilation complete:`);
        console.log(`   - Decisions extracted: ${totalDecisions}`);
        console.log(`   - RCAs extracted:      ${totalRcas}`);
        console.log(`   - DeadEnds logged:     ${totalDeadEnds}`);
        console.log(`   - Wiki Index:          ${storage.paths.wikiIndex}`);
      } finally {
        releaseCompile();
      }
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

    case 'report': {
      const r = buildImpactReport(storage);
      console.log('📈 AgentRunlog Impact Report');
      console.log(`  Sessions recorded:   ${r.sessions} (${Object.entries(r.platforms).map(([k, v]) => `${k}: ${v}`).join(', ') || '-'})`);
      console.log(`  Context injections:  ${r.injections}`);
      console.log(`  Decisions:           ${r.activeDecisions} active / ${r.draftDecisions} draft / ${r.supersededDecisions} superseded`);
      console.log(`  RCAs / Dead ends / Runs: ${r.rcas} / ${r.deadEnds} / ${r.runs}`);
      console.log(`  Lint:                ${r.lintErrors} errors, ${r.lintWarnings} warnings`);
      if (r.repeatedFailures.length) {
        console.log('  Repeated failures (same command failed in several sessions):');
        for (const f of r.repeatedFailures) console.log(`    - ${f.command}  (${f.sessions} sessions)`);
      }
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
      const reindexer = new WikiReindexer(storage, storage.config.compiler as any);
      const res = await reindexer.reindex();
      console.log(
        `✅ Processed ${res.processedSessions} session(s), ${res.totalRecordsGenerated} record(s) re-extracted, ${res.retainedRecords} non-transcript record(s) kept, in ${res.durationMs}ms.`
      );
      if (res.backupDir) console.log(`🗂️  Previous wiki backed up to ${res.backupDir}`);
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
  runlog scan [--alias name] [--force]
                              Scan codebase + past conversations across all 4 platforms
                              (--force re-imports every conversation, ignoring the unchanged-file cache)
  runlog compile [session]    Extract typed knowledge from session transcripts using compiler
  runlog status               Display memory statistics and active context cache size
  runlog lint                 Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex              Rebuild wiki and cache from raw transcripts (NFR-10)
`);
      break;
  }
}

// Every command except the long-running MCP server must terminate when its work is done: a lingering
// handle (detached child, socket) must never leave a CLI/worker process hanging around.
const isServer = command === 'mcp';
main()
  .then(() => {
    if (!isServer) process.stdout.write('', () => process.exit(process.exitCode ?? 0));
  })
  .catch((err) => {
    console.error('Fatal CLI Error:', err);
    process.exit(1);
  });

// Background workers get a hard ceiling so a stuck one can never pile up (locks go stale after 10 min anyway).
if (command === 'sync-history' || command === 'bootstrap' || command === 'compile') {
  setTimeout(() => process.exit(0), 15 * 60 * 1000).unref();
}
