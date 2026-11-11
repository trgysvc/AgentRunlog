#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StorageManager } from '../storage/index.js';
import { WikiLinter } from '../compiler/linter.js';
import { WikiReindexer } from '../compiler/reindex.js';
import { HookManager } from '../hooks/index.js';
import { createRunlogMcpServer } from '../mcp/server.js';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] || 'help';

const storage = new StorageManager();
const hooks = new HookManager(storage);

async function main() {
  switch (command) {
    case 'init': {
      console.log('⚡ Initializing AgentRunlog in current project...');

      // 1. Ensure storage directories
      console.log(`📁 Memory storage: ${storage.paths.root}`);

      // 2. Install platform hooks
      const platformArg = args[1]?.toLowerCase();
      if (!platformArg || platformArg === 'all') {
        const installed = hooks.installAll();
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
      const platform = args[1]?.toLowerCase();
      const event = args[2]?.toLowerCase();
      const sessionId = args[3] || `sess_${Date.now()}`;

      if (platform === 'claude' && event === 'session-start') {
        const push = hooks.claude.handleSessionStart(sessionId);
        if (push) console.log(push);
      } else if (platform === 'antigravity' && event === 'pre-invocation') {
        const push = hooks.antigravity.handlePreInvocation(sessionId, 1);
        if (push) console.log(push);
      } else if (platform === 'cursor' && event === 'before-submit-prompt') {
        hooks.cursor.handlePromptSubmit(sessionId);
      } else if (platform === 'codex' && event === 'session-start') {
        const push = hooks.codex.handleSessionStart(sessionId);
        if (push) console.log(push);
      }
      break;
    }

    default:
      console.log(`
AgentRunlog CLI — Typed Engineering Memory for Coding Agents

Usage:
  runlog init [platform]    Initialize memory and install hooks (claude | antigravity | cursor | codex | all)
  runlog status             Display memory statistics and active context cache size
  runlog lint               Audit wiki for broken supersedes, stale references, and invalid records
  runlog reindex            Rebuild wiki and cache from raw transcripts (NFR-10)
  runlog mcp                Start Model Context Protocol (MCP) server over stdio
  runlog hook <plt> <evt>   Execute platform hook event (< 20ms latency SLA)
`);
      break;
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
