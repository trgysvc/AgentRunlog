import { readFileSync, existsSync } from 'node:fs';
import {
  type Decision,
  DecisionSchema,
  type RCA,
  RCASchema,
  type DeadEnd,
  DeadEndSchema,
  type Task,
  TaskSchema,
  type Run,
  RunSchema,
  type RawSessionEvent,
} from '../types/schemas.js';
import { type StorageManager } from '../storage/index.js';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { formatPushText } from '../storage/push-format.js';
import { hasCompleteEvidence, isNonStructuralFailure } from './evidence.js';
import { heuristicExtract } from './heuristic.js';
import { buildSessionJourney } from './journey.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildLastSession, saveLastSession, loadLastSession, verifiedCommands, gitCommits, staleRecordIds } from './handoff.js';

export interface ExtractedBundle {
  decisions: Decision[];
  rcas: RCA[];
  deadEnds: DeadEnd[];
  tasks: Task[];
  runs?: Run[];
}

export interface CompilerOptions {}

export class TranscriptExtractor {
  private storage: StorageManager;

  constructor(storage: StorageManager, options: CompilerOptions = {}) {
    this.storage = storage;
  }

  /**
   * Reads raw JSONL session file and returns parsed session events
   */
  public readSessionEvents(sessionFilePath: string): RawSessionEvent[] {
    if (!existsSync(sessionFilePath)) return [];
    const content = readFileSync(sessionFilePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const events: RawSessionEvent[] = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        events.push(obj);
      } catch {}
    }
    return events;
  }

  /**
   * Extracts typed records from the captured work (deterministic, no model call) and compiles them.
   */
  public async extractAndCompile(sessionFilePath: string): Promise<ExtractedBundle> {
    const events = this.readSessionEvents(sessionFilePath);
    if (events.length === 0) {
      return { decisions: [], rcas: [], deadEnds: [], tasks: [] };
    }

    const bundle = heuristicExtract(events);
    const projectRoot = dirname(this.storage.paths.root);
    const commits = gitCommits(projectRoot, events[0].timestamp, events[events.length - 1].timestamp);
    this.writeJourney(events, commits);

    // Handoff + open work (works for any compile trigger, not only SessionEnd)
    const lastRun = (bundle.runs || [])[(bundle.runs || []).length - 1];
    const ls = buildLastSession(events, lastRun);
    if (ls) {
      saveLastSession(this.storage, ls);
      if (ls.openWork) for (const t of bundle.tasks) t.status = 'in_progress';
    }
    if (commits.length) for (const t of bundle.tasks) t.commits = commits.map((c) => c.split(' ')[0]);
    this.compileSession(sessionFilePath, bundle);
    return bundle;
  }

  /** Writes wiki/runs/<session>.md (derived, safe to regenerate; raw/ is never touched). */
  private writeJourney(events: RawSessionEvent[], commits: string[] = []): void {
    try {
      const md = buildSessionJourney(events, commits);
      if (!md) return;
      mkdirSync(this.storage.paths.runs, { recursive: true });
      const safe = events[0].sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
      writeFileSync(join(this.storage.paths.runs, `${safe}.md`), md, 'utf8');
    } catch {}
  }

  /**
   * Compiles session events and updates wiki, module pages, index.md and active context cache
   */
  public compileSession(sessionFilePath: string, bundle: ExtractedBundle): void {
    // 1. Save all decisions. Re-compiling must never undo curation: a record that already exists
    //    keeps its lifecycle fields (status, supersededBy, confidence, decidedBy), otherwise a
    //    superseded decision would be resurrected by the next compile (Decision Drift, FR-07).
    const existingById = new Map(this.storage.wiki.listDecisions().map((d) => [d.id, d]));
    for (const dec of bundle.decisions) {
      const parsed = DecisionSchema.safeParse(dec);
      if (!parsed.success) continue;
      // FR-06: no complete transcript evidence -> draft, excluded from push (never silently dropped)
      if (!hasCompleteEvidence(parsed.data.evidence) && parsed.data.status === 'active') parsed.data.status = 'draft';
      const prior = existingById.get(parsed.data.id);
      const record = prior
        ? {
            ...parsed.data,
            status: prior.status,
            supersededBy: prior.supersededBy,
            confidence: prior.confidence,
            decidedBy: prior.decidedBy,
            createdAt: prior.createdAt,
          }
        : parsed.data;
      this.storage.wiki.saveDecision(record);
    }
    this.applySupersedes();

    // 2. Save RCAs
    for (const rca of bundle.rcas) {
      const parsed = RCASchema.safeParse(rca);
      if (parsed.success) {
        if (!hasCompleteEvidence(parsed.data.evidence)) parsed.data.status = 'draft';
        this.storage.wiki.saveRCA(parsed.data);
      }
    }

    // 3. Save DeadEnds (Soft Guardrail check)
    for (const de of bundle.deadEnds) {
      const parsed = DeadEndSchema.safeParse(de);
      if (parsed.success) {
        // FR-05: transient (503/timeout) or plain syntax failures are not dead ends
        if (isNonStructuralFailure(parsed.data.whyFailed)) continue;
        if (!hasCompleteEvidence(parsed.data.evidence)) parsed.data.status = 'draft';
        this.storage.wiki.saveDeadEnd(parsed.data);
      }
    }

    // 4. Save Tasks
    for (const task of bundle.tasks) {
      const parsed = TaskSchema.safeParse(task);
      if (parsed.success) {
        this.storage.wiki.saveTask(parsed.data);
      }
    }

    // 4b. Save Runs (test/build/lint results, FR-04/FR-05)
    for (const run of bundle.runs || []) {
      const parsed = RunSchema.safeParse(run);
      if (parsed.success) this.storage.wiki.saveRun(parsed.data);
    }

    // 5. Generate wiki/index.md and wiki/modules/*.md (FR-08)
    this.storage.wiki.generateIndexAndModules();

    // 6. Regenerate Pre-compiled Context Cache (FR-19, NFR-07)
    this.refreshActiveContextCache();
  }

  /**
   * Derives the supersede graph deterministically (FR-07): every decision listing `supersedes: [X]`
   * marks X as superseded by it. Idempotent, so it is safe after any compile or reindex.
   */
  public applySupersedes(): void {
    const all = this.storage.wiki.listDecisions();
    const byId = new Map(all.map((d) => [d.id, d]));
    for (const newer of all) {
      for (const oldId of newer.supersedes) {
        const old = byId.get(oldId);
        if (!old || old.supersededBy === newer.id) continue;
        old.status = 'superseded';
        old.supersededBy = newer.id;
        old.updatedAt = new Date().toISOString();
        this.storage.wiki.saveDecision(old);
      }
    }
  }

  /**
   * Refreshes the active context cache under the NFR-07 ceiling, measured with a real tokenizer
   * on the exact text the hooks will inject. Honors NFR-08 (minPushConfidence) and FR-06/FR-07
   * (no drafts, no superseded decisions).
   */
  public refreshActiveContextCache(): void {
    const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const minRank = rank[this.storage.config.minPushConfidence ?? 'medium'] ?? 1;
    const ok = (c: string) => (rank[c] ?? 0) >= minRank;
    const maxTokens = this.storage.config.maxPushTokens || 800;

    // Code sync: records whose cited files were all deleted/renamed are not pushed (still in wiki, flagged by lint)
    const stale = staleRecordIds(this.storage, dirname(this.storage.paths.root));

    const recentDeadEnds = this.storage.wiki
      .listDeadEnds()
      .filter((d) => ok(d.confidence) && d.status !== 'draft' && !stale.has(d.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .map((de) => ({
        id: de.id,
        title: de.title.slice(0, 80),
        approach: de.approach.slice(0, 120),
        whyFailed: de.whyFailed.slice(0, 140),
        retryConditions: de.retryConditions.slice(0, 140),
        affectsModules: de.affectsModules,
      }));

    const activeDecisions = this.storage.wiki
      .listDecisions()
      .filter((x) => x.status === 'active' && ok(x.confidence) && !x.supersededBy && !stale.has(x.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((d) => ({
        id: d.id,
        title: d.title.slice(0, 80),
        choice: d.choice.slice(0, 180),
        affectsModules: d.affectsModules,
      }));

    const recentRCAs = this.storage.wiki
      .listRCAs()
      .filter((x) => ok(x.confidence) && x.status !== 'draft' && !stale.has(x.id))
      .slice(-3)
      .reverse()
      .map((r) => ({
        id: r.id,
        title: r.title.slice(0, 80),
        incident: r.incident.slice(0, 120),
        resolution: r.resolution.slice(0, 120),
      }));

    const last = loadLastSession(this.storage);
    const verified = verifiedCommands(this.storage.wiki.listRuns());
    this.writeGuardIndex(stale);

    let lastSession: { sessionId: string; at: string; text: string } | undefined = last
      ? { sessionId: last.sessionId, at: last.at, text: last.text }
      : undefined;
    const build = () => ({ version: 1, lastUpdated: new Date().toISOString(), activeDecisions, recentDeadEnds, recentRCAs, lastSession, verified, estimatedTokens: 0 });
    const measure = () => {
      const text = formatPushText(build(), Number.MAX_SAFE_INTEGER);
      return text ? countTokens(text) : 0;
    };

    // Drop the least valuable item until the injected text fits: RCAs, then decisions, then dead ends.
    let tokens = measure();
    while (tokens > maxTokens && (recentRCAs.length || activeDecisions.length || recentDeadEnds.length || verified.length || lastSession)) {
      if (verified.length > 2) verified.pop();
      else if (recentRCAs.length) recentRCAs.pop();
      else if (activeDecisions.length) activeDecisions.pop();
      else if (recentDeadEnds.length) recentDeadEnds.pop();
      else if (verified.length) verified.pop();
      else lastSession = undefined;
      tokens = measure();
    }

    this.storage.cache.setActiveContext({ ...build(), estimatedTokens: tokens });
  }

  /**
   * cache/guard_index.json: command-keyed known fixes / dead ends the light hook injects on the 2nd
   * failure of the same command in one session (no model, no heavy imports at hook time).
   */
  private writeGuardIndex(stale: Set<string>): void {
    try {
      const entries: Array<{ id: string; kind: string; key: string; text: string }> = [];
      for (const r of this.storage.wiki.listRCAs()) {
        if (r.status === 'draft' || stale.has(r.id)) continue;
        const key = r.title.replace(/^Command Failed:\s*/, '').trim();
        if (key.length >= 4) entries.push({ id: r.id, kind: 'rca', key: key.slice(0, 160), text: `[${r.id}] Known fix: ${r.resolution.slice(0, 160)}` });
      }
      for (const d of this.storage.wiki.listDeadEnds()) {
        if (d.status === 'draft' || stale.has(d.id)) continue;
        const key = d.approach.trim();
        if (key.length >= 6) entries.push({ id: d.id, kind: 'dead_end', key: key.slice(0, 160), text: `[${d.id}] Dead end: ${d.whyFailed.slice(0, 120)}. Retry only if: ${d.retryConditions.slice(0, 100)}` });
      }
      mkdirSync(this.storage.paths.cache, { recursive: true });
      writeFileSync(join(this.storage.paths.cache, 'guard_index.json'), JSON.stringify(entries), 'utf8');
    } catch {}
  }
}
