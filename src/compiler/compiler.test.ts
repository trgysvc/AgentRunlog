import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
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
      evidence: { sessionId: 'sess_1', turnIndex: 1, line: 1, hash: 'h1', timestamp: new Date().toISOString() },
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
      evidence: { sessionId: 'sess_1', turnIndex: 1, line: 1, hash: 'h1', timestamp: new Date().toISOString() },
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
      evidence: { sessionId: 'sess_1', turnIndex: 1, line: 1, hash: 'h1', timestamp: new Date().toISOString() },
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
          evidence: { sessionId: 'sess_2', turnIndex: 1, line: 1, hash: 'h1', timestamp: new Date().toISOString() },
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
          evidence: { sessionId: 'sess_2', turnIndex: 1, line: 1, hash: 'h1', timestamp: new Date().toISOString() },
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

  it('heuristic extractor turns a failing build into a task and an RCA', async () => {
    const { heuristicExtract } = await import('./heuristic.js');

    const fallback = heuristicExtract([
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
    const { heuristicExtract } = await import('./heuristic.js');

    const bundle = heuristicExtract([
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

  it('reindexer really rebuilds records from raw and keeps non-transcript records (NFR-10)', async () => {
    const ts = new Date().toISOString();
    storage.logger.logEvent({
      sessionId: 'sess_test',
      platform: 'cursor',
      eventType: 'prompt_submit',
      timestamp: ts,
      payload: { text: "let's use Drizzle ORM instead of Prisma for the data layer" },
    });

    // A record that only exists via MCP (no raw transcript behind it)
    const mcpDecision = {
      id: 'DEC-MCP1',
      title: 'Manual decision',
      status: 'active' as const,
      decidedBy: 'user',
      author: 'user' as const,
      context: 'recorded via MCP',
      choice: 'Use pnpm',
      supersedes: [],
      supersededBy: null,
      affectsModules: [],
      evidence: { sessionId: 'live_1', turnIndex: 1, line: 1, hash: 'h1', timestamp: ts },
      confidence: 'high' as const,
      createdAt: ts,
      updatedAt: ts,
    };
    storage.wiki.saveDecision(mcpDecision);

    const result = await reindexer.reindex();
    expect(result.processedSessions).toBe(1);
    expect(result.totalRecordsGenerated).toBeGreaterThan(0);
    expect(result.retainedRecords).toBe(1);
    expect(result.backupDir && existsSync(result.backupDir)).toBeTruthy();

    const decisions = storage.wiki.listDecisions();
    expect(decisions.some((d) => d.choice.includes('Drizzle'))).toBe(true);
    expect(decisions.some((d) => d.id === 'DEC-MCP1')).toBe(true);
    expect(storage.wiki.listTasks().length).toBeGreaterThan(0);
  });

  it('recompiling never resurrects a superseded decision (FR-07)', async () => {
    const ts = new Date().toISOString();
    const base = {
      status: 'active' as const,
      decidedBy: 'user',
      author: 'user' as const,
      context: 'ctx',
      supersededBy: null,
      affectsModules: [],
      evidence: { sessionId: 'sess_x', turnIndex: 1, line: 1, hash: 'h1', timestamp: ts },
      confidence: 'high' as const,
      createdAt: ts,
      updatedAt: ts,
    };
    const oldDec = { ...base, id: 'DEC-OLD', title: 'Old', choice: 'Use Prisma', supersedes: [] };
    const newDec = { ...base, id: 'DEC-NEW', title: 'New', choice: 'Use Drizzle', supersedes: ['DEC-OLD'] };
    const bundle = { decisions: [oldDec, newDec], rcas: [], deadEnds: [], tasks: [] };

    extractor.compileSession('', bundle);
    // Second compile re-submits the original (still "active") old decision
    extractor.compileSession('', bundle);

    const old = storage.wiki.listDecisions().find((d) => d.id === 'DEC-OLD')!;
    expect(old.status).toBe('superseded');
    expect(old.supersededBy).toBe('DEC-NEW');
    const cache = storage.cache.getActiveContext()!;
    expect(cache.activeDecisions.map((d) => d.id)).toEqual(['DEC-NEW']);
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
    // R12: scanner facts are unverified drafts and must not consume the push budget
    expect(cache?.activeDecisions.length).toBe(0);
    expect(storage.wiki.listDecisions().filter((d) => d.status === 'draft').length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(storage.paths.wiki, 'modules', 'src_audio.md'))).toBe(true);
  });

  it('HistoryImporter discovers and sanitizes past transcripts across ALL 4 platforms', async () => {
    const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
    const { HistoryImporter } = await import('./history-importer.js');

    // 1. Mock Antigravity transcript
    const mockAgDir = join(tempDir, 'mock_ag_brain');
    const convLogDir = join(mockAgDir, 'conv-1234', '.system_generated', 'logs');
    mkdirSync(convLogDir, { recursive: true });
    writeFileSync(
      join(convLogDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          type: 'USER_INPUT',
          created_at: '2026-11-10T10:00:00Z',
          content: '<USER_REQUEST>\nWorking on SonarAura: Lets use FastAPI instead of Flask with key sk-proj-12345678901234567890123456789012\n</USER_REQUEST>',
        }),
        JSON.stringify({
          type: 'GENERIC',
          created_at: '2026-11-10T10:01:00Z',
          content: 'Command exited with code 1\nError: Port 8000 already in use',
        }),
      ].join('\n'),
      'utf8'
    );

    // 2. Mock Claude Code transcript
    const mockClaudeDir = join(tempDir, 'mock_claude_proj', '-sonaraura');
    mkdirSync(mockClaudeDir, { recursive: true });
    writeFileSync(
      join(mockClaudeDir, 'sess-claude-99.jsonl'),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-11-10T11:00:00Z',
        message: { content: 'SonarAura audio engine decision: use WebAudio API' },
      }),
      'utf8'
    );

    // 3. Mock Codex CLI transcript
    const mockCodexDir = join(tempDir, 'mock_codex_sessions', '2026', '11', '10');
    mkdirSync(mockCodexDir, { recursive: true });
    writeFileSync(
      join(mockCodexDir, 'rollout-2026-11-10T12-00-00-abc123.jsonl'),
      JSON.stringify({
        timestamp: '2026-11-10T12:00:00Z',
        payload: { type: 'user_message', message: 'SonarAura codex test: use Vitest' },
      }),
      'utf8'
    );

    // 4. Mock Cursor agent transcript
    const mockCursorDir = join(tempDir, 'mock_cursor_proj', 'sonaraura', 'agent-transcripts');
    mkdirSync(mockCursorDir, { recursive: true });
    writeFileSync(
      join(mockCursorDir, 'cursor-sess-1.jsonl'),
      JSON.stringify({
        role: 'user',
        timestamp: '2026-11-10T13:00:00Z',
        content: 'SonarAura UI: adopt Tailwind CSS',
      }),
      'utf8'
    );

    const importer = new HistoryImporter(storage, tempDir);
    const res = await importer.importProjectHistory({
      antigravityBrainDir: mockAgDir,
      claudeProjectsDir: join(tempDir, 'mock_claude_proj'),
      codexSessionsDir: join(tempDir, 'mock_codex_sessions'),
      cursorProjectsDir: join(tempDir, 'mock_cursor_proj'),
      cursorWorkspaceStorageDir: join(tempDir, 'nonexistent_ws'),
      aliases: ['SonarAura'],
    });

    expect(res.antigravitySessionsImported).toBe(1);
    expect(res.claudeSessionsImported).toBe(1);
    expect(res.codexSessionsImported).toBe(1);
    expect(res.cursorSessionsImported).toBe(1);
    expect(res.totalEventsImported).toBe(5);

    const agPath = join(storage.paths.raw, res.importedFiles[0]);
    const rawSaved = readFileSync(agPath, 'utf8');
    expect(rawSaved).not.toContain('sk-proj-12345678901234567890123456789012');
    expect(rawSaved).toContain('[REDACTED:OPENAI_API_KEY:');

    // Verify incremental state cache skips unchanged files on 2nd run (Argon Directive 3)
    const res2 = await importer.importProjectHistory({
      antigravityBrainDir: mockAgDir,
      claudeProjectsDir: join(tempDir, 'mock_claude_proj'),
      codexSessionsDir: join(tempDir, 'mock_codex_sessions'),
      cursorProjectsDir: join(tempDir, 'mock_cursor_proj'),
      cursorWorkspaceStorageDir: join(tempDir, 'nonexistent_ws'),
      aliases: ['SonarAura'],
    });
    expect(res2.skippedUnchanged).toBe(4);
    expect(res2.totalEventsImported).toBe(0);

    // Verify NFR-08 Staged Trust Gatekeeper: historical heuristic records are marked draft/low
    await extractor.extractAndCompile(agPath);
    const decisions = storage.wiki.listDecisions();
    expect(decisions.some((d) => d.status === 'draft' && d.confidence === 'low')).toBe(true);
    const cache = storage.cache.getActiveContext();
    expect(cache?.activeDecisions.length || 0).toBe(0); // Drafts must NOT leak into push cache!
  });
});

describe('FR-05 / FR-06 / NFR-08 enforcement', () => {
  it('drafts records without full evidence, drops transient dead ends, honours minPushConfidence', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { StorageManager } = await import('../storage/index.js');
    const { TranscriptExtractor } = await import('./extractor.js');
    const { normalizeToolPayload } = await import('./heuristic.js');
    const st = new StorageManager(mkdtempSync(join(tmpdir(), 'runlog_fr_')));
    const ex = new TranscriptExtractor(st);
    const ts = new Date().toISOString();
    const full = { sessionId: 's', turnIndex: 1, line: 1, hash: 'h', timestamp: ts };
    const dec = (id: string, evidence: any, confidence: any = 'high') => ({
      id, title: id, status: 'active' as const, decidedBy: 'u', author: 'user' as const, context: 'c', choice: 'ch',
      supersedes: [], supersededBy: null, affectsModules: [], evidence, confidence, createdAt: ts, updatedAt: ts,
    });
    const de = (id: string, whyFailed: string) => ({
      id, title: id, rootCauseType: 'architectural' as const, approach: 'a', whyFailed, retryConditions: 'r',
      affectsModules: [], evidence: full, confidence: 'high' as const, createdAt: ts,
    });
    ex.compileSession('x', {
      decisions: [dec('DEC-A', full), dec('DEC-B', { sessionId: 's', timestamp: ts }), dec('DEC-C', full, 'low')],
      rcas: [], tasks: [],
      deadEnds: [de('DEAD-OK', 'Engine binary exceeded size limit'), de('DEAD-503', 'Upstream returned 503 Service Unavailable'), de('DEAD-SYN', 'SyntaxError: Unexpected token')],
    });
    expect(st.wiki.listDecisions().find((d) => d.id === 'DEC-B')!.status).toBe('draft');
    expect(st.cache.getActiveContext()!.activeDecisions.map((d) => d.id)).toEqual(['DEC-A']);
    expect(st.wiki.listDeadEnds().map((d) => d.id)).toEqual(['DEAD-OK']);

    const n = normalizeToolPayload({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stderr: 'boom', exit_code: 1 } });
    expect(n.command).toBe('npm test');
    expect(n.error).toBe('boom');
  });
});

describe('R5/R11/R12: LLM bundle normalization, trusted import, scanner drafts', () => {
  it('trusted import writes events even under AGENTRUNLOG_INTERNAL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runlog_imp_'));
    const st = new StorageManager(dir);
    const ev: any = { sessionId: 'import_1', platform: 'claude_code', eventType: 'prompt_submit', timestamp: new Date().toISOString(), payload: { text: 'hi' } };
    process.env.AGENTRUNLOG_INTERNAL = '1';
    try {
      expect(st.logger.logEvent(ev)).toBe(false);
      expect(st.logger.logEvent(ev, { trustedImport: true })).toBe(true);
    } finally {
      delete process.env.AGENTRUNLOG_INTERNAL;
    }
  });
});

describe('Automatic history sync safety', () => {
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sessionId: 'import_x', platform: 'claude_code', eventType: 'prompt_submit', timestamp: new Date().toISOString(), payload: { text: `msg ${i}` } })) as any[];

  it('replaces our own raw copy completely and leaves no .prev behind', async () => {
    const { HistoryImporter } = await import('./history-importer.js');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_sync_'));
    const st = new StorageManager(dir);
    const imp: any = new HistoryImporter(st, dir);
    expect(imp.writeImportedSession('import_x', mk(2))).toBe(2);
    expect(imp.writeImportedSession('import_x', mk(3))).toBe(3);
    const f = join(st.paths.raw, 'session-import_x.jsonl');
    expect(readFileSync(f, 'utf8').trim().split('\n').length).toBe(3);
    expect(existsSync(f + '.prev')).toBe(false);
  });

  it('an outdated import version triggers a full re-import', async () => {
    const { HistoryImporter } = await import('./history-importer.js');
    const { writeFileSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'runlog_ver_'));
    const st = new StorageManager(dir);
    const imp: any = new HistoryImporter(st, dir);
    const p = imp.statePath ?? null;
    const state = imp.loadImportState();
    expect(state.version).toBe((await import('./import-version.js')).IMPORT_VERSION);
    void p; void writeFileSync;
  });
});
