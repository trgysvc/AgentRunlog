import { readdirSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { TranscriptExtractor, type ExtractedBundle } from './extractor.js';

export interface ReindexResult {
  processedSessions: number;
  totalRecordsGenerated: number;
  durationMs: number;
}

export class WikiReindexer {
  private storage: StorageManager;
  private extractor: TranscriptExtractor;

  constructor(storage: StorageManager) {
    this.storage = storage;
    this.extractor = new TranscriptExtractor(storage);
  }

  /**
   * Cleans wiki and cache, and re-compiles everything from raw/ transcripts (NFR-10)
   */
  public reindex(customBundles?: Map<string, ExtractedBundle>): ReindexResult {
    const start = Date.now();

    // 1. Clean existing wiki directories
    const wikiDirs = [
      this.storage.paths.decisions,
      this.storage.paths.rca,
      this.storage.paths.deadEnds,
      this.storage.paths.tasks,
      this.storage.paths.runs,
    ];

    for (const dir of wikiDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
      }
    }

    // 2. Discover all raw sessions
    if (!existsSync(this.storage.paths.raw)) {
      return { processedSessions: 0, totalRecordsGenerated: 0, durationMs: Date.now() - start };
    }

    const sessionFiles = readdirSync(this.storage.paths.raw)
      .filter((f) => f.startsWith('session-') && f.endsWith('.jsonl'))
      .sort();

    let recordCount = 0;

    for (const sessionFile of sessionFiles) {
      const fullPath = join(this.storage.paths.raw, sessionFile);
      const events = this.extractor.readSessionEvents(fullPath);
      if (events.length === 0) continue;

      const bundle = customBundles?.get(sessionFile) || {
        decisions: [],
        rcas: [],
        deadEnds: [],
        tasks: [],
      };

      this.extractor.compileSession(fullPath, bundle);
      recordCount +=
        bundle.decisions.length + bundle.rcas.length + bundle.deadEnds.length + bundle.tasks.length;
    }

    this.extractor.refreshActiveContextCache();

    return {
      processedSessions: sessionFiles.length,
      totalRecordsGenerated: recordCount,
      durationMs: Date.now() - start,
    };
  }
}
