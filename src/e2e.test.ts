import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from './storage/index.js';
import { HookManager } from './hooks/index.js';
import { RunlogMcpTools } from './mcp/tools.js';
import { WikiLinter } from './compiler/linter.js';
import { TranscriptExtractor } from './compiler/extractor.js';
import { WikiReindexer } from './compiler/reindex.js';

describe('End-to-End System Integration Flow', () => {
  let projectDir: string;
  let storage: StorageManager;
  let hooks: HookManager;
  let mcpTools: RunlogMcpTools;
  let linter: WikiLinter;
  let extractor: TranscriptExtractor;
  let reindexer: WikiReindexer;

  beforeEach(() => {
    projectDir = join(tmpdir(), `agentrunlog_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new StorageManager(projectDir);
    hooks = new HookManager(storage);
    mcpTools = new RunlogMcpTools(storage);
    linter = new WikiLinter(storage, projectDir);
    extractor = new TranscriptExtractor(storage);
    reindexer = new WikiReindexer(storage);
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('runs complete lifecycle: Hook Capture -> Sanitization -> Compile -> MCP Query -> Linter -> Reindex', () => {
    // 1. Session 1 Starts on Claude Code
    const sessionId1 = 'sess_prod_001';
    const initialPush = hooks.claude.handleSessionStart(sessionId1);
    expect(initialPush).toBeNull(); // Empty memory initially

    // 2. User prompt contains sensitive database URI
    const logged = storage.logger.logEvent({
      sessionId: sessionId1,
      platform: 'claude_code',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: {
        text: 'Deploy backend with postgres://admin:super_secret_999@db.prod:5432/main',
      },
    });
    expect(logged).toBe(true);

    // Verify secret was redacted on disk
    const rawFile = join(storage.paths.raw, `session-${sessionId1}.jsonl`);
    const rawContent = readFileSync(rawFile, 'utf8');
    expect(rawContent).not.toContain('super_secret_999');
    expect(rawContent).toContain('[REDACTED:PASSWORD:');

    // 3. Compiler processes session: records DEC-001 (Postgres) and DEAD-001 (Heavy ORM)
    extractor.compileSession(rawFile, {
      decisions: [
        {
          id: 'DEC-001',
          title: 'Direct SQL with PgTyped',
          status: 'active',
          decidedBy: 'Turgay',
          author: 'team',
          context: 'Need type-safe queries without heavy runtime overhead',
          choice: 'Use PgTyped for compile-time SQL validation',
          supersedes: [],
          supersededBy: null,
          affectsModules: ['src/db/**'],
          evidence: { sessionId: sessionId1, turnIndex: 3, timestamp: new Date().toISOString() },
          confidence: 'high',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      rcas: [],
      deadEnds: [
        {
          id: 'DEAD-001',
          title: 'Prisma Client on Edge Functions',
          rootCauseType: 'architectural',
          approach: 'Bundle Prisma binary in Cloudflare Workers',
          whyFailed: 'Engine binary exceeded 1MB script size limit and crashed',
          retryConditions: 'Do not use unless Prisma Accelerate or serverless driver is enabled',
          affectsModules: ['src/db/**'],
          evidence: { sessionId: sessionId1, turnIndex: 8, timestamp: new Date().toISOString() },
          confidence: 'high',
          createdAt: new Date().toISOString(),
        },
      ],
      tasks: [],
    });

    // 4. Session 2 Starts on Antigravity
    const sessionId2 = 'sess_prod_002';
    const pushSession2 = hooks.antigravity.handlePreInvocation(sessionId2, 1);
    expect(pushSession2).toContain('DEC-001');
    expect(pushSession2).toContain('DEAD-001');

    // 5. Agent in Session 2 queries MCP tools
    const deadEndCheck = mcpTools.checkDeadEnds({
      approach: 'Bundle Prisma in serverless worker',
    });
    expect(deadEndCheck.hasKnownFailures).toBe(true);
    expect(deadEndCheck.warningMessage).toContain('⚠️ WARNING: 1 prior failed attempt');
    expect(deadEndCheck.warningMessage).toContain('Prisma Accelerate');

    // 6. Architectural Pivot: Team adopts Drizzle ORM, superseding DEC-001
    extractor.compileSession('session2_file', {
      decisions: [
        {
          id: 'DEC-002',
          title: 'Adopt Drizzle ORM',
          status: 'active',
          decidedBy: 'Turgay',
          author: 'team',
          context: 'Better migrations and zero-overhead SQL-like builder',
          choice: 'Drizzle ORM across all modules',
          supersedes: ['DEC-001'],
          supersededBy: null,
          affectsModules: ['src/db/**'],
          evidence: { sessionId: sessionId2, turnIndex: 5, timestamp: new Date().toISOString() },
          confidence: 'high',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      rcas: [],
      deadEnds: [],
      tasks: [],
    });

    // Verify DEC-001 is now superseded and DEC-002 is active
    const searchResult = mcpTools.searchRunlog({ query: 'SQL' });
    expect(searchResult.results.length).toBe(1);
    expect(searchResult.results[0].id).toBe('DEC-002'); // DEC-001 was superseded and excluded!

    // 7. Linter checks health
    const lintReport = linter.lint();
    expect(lintReport.issueCount.errors).toBe(0);

    // 8. Reindexer guarantees full recovery from raw transcripts (NFR-10)
    const reindexRes = reindexer.reindex();
    expect(reindexRes.processedSessions).toBe(2); // sess_prod_001 and sess_prod_002
  });

  it('auto-bootstraps valid project directories automatically without manual init', async () => {
    const { writeFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { isValidProjectDirectory, ensureProjectBootstrapped } = await import('./compiler/auto-bootstrap.js');

    // Must safely refuse $HOME
    expect(isValidProjectDirectory(homedir())).toBe(false);

    // Create a fresh uninitialized project directory
    const autoProjDir = join(tmpdir(), `agentrunlog_autoboot_${Date.now()}`);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(autoProjDir, { recursive: true });
    writeFileSync(join(autoProjDir, 'package.json'), JSON.stringify({ name: 'auto-proj', dependencies: { zod: '3.0.0' } }), 'utf8');
    writeFileSync(join(autoProjDir, '.gitignore'), 'node_modules/\n', 'utf8');

    expect(isValidProjectDirectory(autoProjDir)).toBe(true);

    // First call auto-bootstraps completely
    const first = await ensureProjectBootstrapped(autoProjDir);
    expect(first.bootstrappedNow).toBe(true);
    expect(existsSync(join(autoProjDir, '.agentrunlog', 'cache', 'bootstrap.done'))).toBe(true);
    expect(readFileSync(join(autoProjDir, '.gitignore'), 'utf8')).toContain('.agentrunlog/raw/');

    // Second call skips immediately
    const second = await ensureProjectBootstrapped(autoProjDir);
    expect(second.bootstrappedNow).toBe(false);

    rmSync(autoProjDir, { recursive: true, force: true });
  });
});
