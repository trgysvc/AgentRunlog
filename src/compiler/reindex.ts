import { readdirSync, existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { TranscriptExtractor, type CompilerOptions } from './extractor.js';

export interface ReindexResult {
  processedSessions: number;
  totalRecordsGenerated: number;
  retainedRecords: number;
  backupDir: string | null;
  durationMs: number;
}

export class WikiReindexer {
  private storage: StorageManager;
  private extractor: TranscriptExtractor;

  constructor(storage: StorageManager, options: CompilerOptions = {}) {
    this.storage = storage;
    this.extractor = new TranscriptExtractor(storage, options);
  }

  /**
   * Rebuilds wiki and cache from raw/ transcripts (NFR-10).
   *
   * - The previous wiki is copied to <root>/backup/reindex-<timestamp> before anything is removed.
   * - Records whose evidence session has no raw transcript (MCP `record_*` entries, codebase scan)
   *   cannot be re-derived, so they are carried over instead of being lost.
   */
  public async reindex(): Promise<ReindexResult> {
    const start = Date.now();
    const { paths, wiki } = this.storage;

    const recordDirs = [paths.decisions, paths.rca, paths.deadEnds, paths.tasks, paths.runs];

    // 1. Discover raw sessions and the session ids they contain
    const sessionFiles = existsSync(paths.raw)
      ? readdirSync(paths.raw)
          .filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
          .sort()
      : [];
    const rawSessionIds = new Set<string>();
    for (const f of sessionFiles) {
      for (const e of this.extractor.readSessionEvents(join(paths.raw, f))) rawSessionIds.add(e.sessionId);
    }

    // 2. Snapshot records that raw cannot reproduce
    const isOrphan = (r: { evidence: { sessionId: string } }) => !rawSessionIds.has(r.evidence.sessionId);
    const keep = {
      decisions: wiki.listDecisions().filter(isOrphan),
      rcas: wiki.listRCAs().filter(isOrphan),
      deadEnds: wiki.listDeadEnds().filter(isOrphan),
      tasks: wiki.listTasks().filter(isOrphan),
    };

    // 3. Back up, then clean
    let backupDir: string | null = null;
    if (existsSync(paths.wiki)) {
      backupDir = join(paths.root, 'backup', `reindex-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(backupDir, { recursive: true });
      cpSync(paths.wiki, join(backupDir, 'wiki'), { recursive: true });
    }
    for (const dir of recordDirs) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }

    // 4. Re-extract from every raw session (real extraction, not empty bundles)
    let recordCount = 0;
    let processed = 0;
    for (const f of sessionFiles) {
      const bundle = await this.extractor.extractAndCompile(join(paths.raw, f));
      processed++;
      recordCount += bundle.decisions.length + bundle.rcas.length + bundle.deadEnds.length + bundle.tasks.length;
    }

    // 5. Restore orphans, then re-derive the supersede graph and caches
    this.extractor.compileSession('', keep);
    this.extractor.refreshActiveContextCache();

    return {
      processedSessions: processed,
      totalRecordsGenerated: recordCount,
      retainedRecords:
        keep.decisions.length + keep.rcas.length + keep.deadEnds.length + keep.tasks.length,
      backupDir,
      durationMs: Date.now() - start,
    };
  }
}
