import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StorageManager } from '../storage/index.js';
import { WikiLinter } from './linter.js';
import { TranscriptExtractor } from './extractor.js';
import { WikiReindexer } from './reindex.js';

describe('Compiler & Linter Engine', () => {
  let tempDir: string;
  let storage: StorageManager;
  let linter: WikiLinter;
  let extractor: TranscriptExtractor;
  let reindexer: WikiReindexer;

  beforeEach(() => {
    tempDir = join(tmpdir(), `agentrunlog_comp_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new StorageManager(tempDir);
    linter = new WikiLinter(storage, tempDir);
    extractor = new TranscriptExtractor(storage);
    reindexer = new WikiReindexer(storage);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('linter catches broken supersedes link and missing retry conditions', () => {
    // 1. Decision superseding non-existent decision
    storage.wiki.saveDecision({
      id: 'DEC-010',
      title: 'Broken Decision',
      status: 'active',
      decidedBy: 'Turgay',
      author: 'team',
      context: 'Test context',
      choice: 'Test choice',
      supersedes: ['DEC-NONEXISTENT'],
      supersededBy: null,
      affectsModules: [],
      evidence: { sessionId: 'sess_1', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 2. DeadEnd with empty retryConditions (violates FR-20)
    storage.wiki.saveDeadEnd({
      id: 'DEAD-005',
      title: 'Bad DeadEnd',
      rootCauseType: 'architectural',
      approach: 'Tried bad approach',
      whyFailed: 'Crashed',
      retryConditions: '', // Empty!
      affectsModules: [],
      evidence: { sessionId: 'sess_1', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
    });

    const report = linter.lint();
    expect(report.issueCount.errors).toBe(2);
    expect(report.issues.some((i) => i.code === 'BROKEN_SUPERSEDES_LINK')).toBe(true);
    expect(report.issues.some((i) => i.code === 'MISSING_RETRY_CONDITIONS')).toBe(true);
  });

  it('extractor compiles bundle and automatically links supersedes (FR-07)', () => {
    // Save DEC-001 initially
    storage.wiki.saveDecision({
      id: 'DEC-001',
      title: 'Use SQLite',
      status: 'active',
      decidedBy: 'Turgay',
      author: 'team',
      context: 'Initial db choice',
      choice: 'SQLite embedded',
      supersedes: [],
      supersededBy: null,
      affectsModules: ['src/db/**'],
      evidence: { sessionId: 'sess_1', timestamp: new Date().toISOString() },
      confidence: 'high',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // New decision DEC-002 supersedes DEC-001
    extractor.compileSession('dummy_path', {
      decisions: [
        {
          id: 'DEC-002',
          title: 'Migrate to Markdown Wiki',
          status: 'active',
          decidedBy: 'Turgay',
          author: 'team',
          context: 'Karpathy wiki pattern is superior to opaque SQLite',
          choice: 'Markdown files with frontmatter',
          supersedes: ['DEC-001'],
          supersededBy: null,
          affectsModules: ['src/storage/**'],
          evidence: { sessionId: 'sess_2', timestamp: new Date().toISOString() },
          confidence: 'high',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      rcas: [],
      deadEnds: [
        {
          id: 'DEAD-001',
          title: 'Heavy Vector DB in Hook',
          rootCauseType: 'architectural',
          approach: 'ChromaDB in PreToolUse',
          whyFailed: 'Hook timeout > 500ms',
          retryConditions: 'Only if running in background worker',
          affectsModules: ['src/hooks/**'],
          evidence: { sessionId: 'sess_2', timestamp: new Date().toISOString() },
          confidence: 'high',
          createdAt: new Date().toISOString(),
        },
      ],
      tasks: [],
    });

    // Check that DEC-001 was updated to supersededBy = 'DEC-002'
    const updatedDec1 = storage.wiki.listDecisions().find((d) => d.id === 'DEC-001');
    expect(updatedDec1?.status).toBe('superseded');
    expect(updatedDec1?.supersededBy).toBe('DEC-002');

    // Check active context cache was updated and only has active decisions (NFR-07, FR-19)
    const cache = storage.cache.getActiveContext();
    expect(cache?.activeDecisions.length).toBe(1);
    expect(cache?.activeDecisions[0].id).toBe('DEC-002');
    expect(cache?.recentDeadEnds.length).toBe(1);

    // Check wiki/index.md and module markdown pages are generated (FR-08)
    expect(existsSync(storage.paths.wikiIndex)).toBe(true);
    const indexContent = readFileSync(storage.paths.wikiIndex, 'utf8');
    expect(indexContent).toContain('DEC-002');
    expect(indexContent).toContain('Migrate to Markdown Wiki');
    expect(indexContent).toContain('Module Context Directory');

    const moduleFile = join(storage.paths.wiki, 'modules', 'src_storage.md');
    expect(existsSync(moduleFile)).toBe(true);
  });

  it('LLMCompilerClient strips markdown fences and provides heuristic fallback', async () => {
    const { LLMCompilerClient } = await import('./llm-client.js');
    const client = new LLMCompilerClient({ provider: 'heuristic' });

    const parsed = client.parseJSONBundle('```json\n{"decisions": [], "rcas": [], "deadEnds": [], "tasks": []}\n```');
    expect(parsed.decisions).toEqual([]);

    const fallback = await client.extract('dummy', [
      {
        sessionId: 'sess_fallback',
        platform: 'claude_code',
        eventType: 'prompt_submit',
        timestamp: new Date().toISOString(),
        payload: { text: 'Fix broken build script' },
      },
      {
        sessionId: 'sess_fallback',
        platform: 'claude_code',
        eventType: 'post_tool_use',
        timestamp: new Date().toISOString(),
        payload: { command: 'npm run build', exitCode: 1, error: 'TS2304 error' },
      },
    ]);

    expect(fallback.tasks.length).toBe(1);
    expect(fallback.rcas.length).toBe(1);
    expect(fallback.rcas[0].incident).toContain('TS2304');
  });

  it('heuristic extractor automatically detects decisions and repeated-failure dead ends without user prompts', async () => {
    const { LLMCompilerClient } = await import('./llm-client.js');
    const client = new LLMCompilerClient({ provider: 'heuristic' });

    const bundle = await client.extract('dummy', [
      {
        sessionId: 'sess_auto',
        platform: 'antigravity',
        eventType: 'prompt_submit',
        timestamp: new Date().toISOString(),
        payload: { text: "Let's use Drizzle ORM instead of Prisma for Edge compatibility" },
      },
      {
        sessionId: 'sess_auto',
        platform: 'antigravity',
        eventType: 'post_tool_use',
        timestamp: new Date().toISOString(),
        payload: { command: 'npx prisma generate', exitCode: 1, error: 'Binary size limit exceeded' },
      },
      {
        sessionId: 'sess_auto',
        platform: 'antigravity',
        eventType: 'post_tool_use',
        timestamp: new Date().toISOString(),
        payload: { command: 'npx prisma generate', exitCode: 1, error: 'Binary size limit exceeded' },
      },
    ]);

    expect(bundle.decisions.length).toBe(1);
    expect(bundle.decisions[0].choice).toContain('Drizzle ORM');
    expect(bundle.deadEnds.length).toBe(1);
    expect(bundle.deadEnds[0].approach).toBe('npx prisma generate');
    expect(bundle.deadEnds[0].whyFailed).toContain('Failed 2 times');
  });

  it('reindexer can reconstruct knowledge base from scratch (NFR-10)', () => {
    // Log an event to raw
    storage.logger.logEvent({
      sessionId: 'sess_test',
      platform: 'cursor',
      eventType: 'prompt_submit',
      timestamp: new Date().toISOString(),
      payload: { query: 'Initial prompt' },
    });

    const result = reindexer.reindex();
    expect(result.processedSessions).toBe(1);
    expect(existsSync(storage.paths.wiki)).toBe(true);
  });

  it('CodebaseScanner bootstraps tech stack, modules, and docs for mid-project setup', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { CodebaseScanner } = await import('./scanner.js');

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'sonaraura-web',
        dependencies: { next: '15.0.0', react: '19.0.0', zod: '3.24.0' },
        scripts: { dev: 'next dev', build: 'next build' },
      }),
      'utf8'
    );
    mkdirSync(join(tempDir, 'src', 'audio'), { recursive: true });
    mkdirSync(join(tempDir, 'src', 'auth'), { recursive: true });
    writeFileSync(join(tempDir, 'README.md'), '# SonarAura\nSpatial audio player and streaming architecture.', 'utf8');

    const scanner = new CodebaseScanner(storage, tempDir);
    const result = scanner.scan();

    expect(result.detectedStacks).toContain('Node.js / JavaScript / TypeScript');
    expect(result.indexedModules).toContain('src/audio/**');
    expect(result.indexedModules).toContain('src/auth/**');
    expect(result.decisionsCreated).toBeGreaterThanOrEqual(2);

    const cache = storage.cache.getActiveContext();
    expect(cache?.activeDecisions.length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(storage.paths.wiki, 'modules', 'src_audio.md'))).toBe(true);
  });
});
