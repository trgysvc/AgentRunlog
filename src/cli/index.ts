#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StorageManager } from '../storage/index.js';
import { WikiLinter } from '../compiler/linter.js';
import { WikiReindexer } from '../compiler/reindex.js';
import { TranscriptExtractor } from '../compiler/extractor.js';
import { HookManager } from '../hooks/index.js';
import { createRunlogMcpServer } from '../mcp/server.js';
import { existsSync, readFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] || 'help';

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
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
      const platformArg = args[1]?.toLowerCase();
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

      console.log('\n🎉 AgentRunlog initialized successfully! Your coding agents now retain persistent memory.');
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
