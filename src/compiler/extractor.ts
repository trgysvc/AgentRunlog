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
  type RawSessionEvent,
} from '../types/schemas.js';
import { type StorageManager } from '../storage/index.js';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { formatPushText } from '../storage/push-format.js';
import { hasCompleteEvidence, isNonStructuralFailure } from './evidence.js';
import { LLMCompilerClient, type LLMClientConfig } from './llm-client.js';

export interface ExtractedBundle {
  decisions: Decision[];
  rcas: RCA[];
  deadEnds: DeadEnd[];
  tasks: Task[];
}

export interface CompilerOptions extends LLMClientConfig {}

export class TranscriptExtractor {
  private storage: StorageManager;
  private llmClient: LLMCompilerClient;

  constructor(storage: StorageManager, options: CompilerOptions = {}) {
    this.storage = storage;
    this.llmClient = new LLMCompilerClient(options);
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
   * Builds Karpathy LLM Wiki compiler prompt based on schema.md
   */
  public buildCompilerPrompt(events: RawSessionEvent[]): string {
    const sessionId = events[0]?.sessionId ?? 'unknown';
    const formattedEvents = events.map((e, idx) => {
      return `Turn ${idx + 1} [${e.eventType} - ${e.timestamp}]:\n${JSON.stringify(e.payload, null, 2)}`;
    }).join('\n\n');

    return `You are the AgentRunlog Compiler Worker. Transform the raw coding-agent transcript (session "${sessionId}") into typed engineering memory records.

CRITICAL RULES:
1. STRICT EVIDENCE: every record must carry "evidence": {"turnIndex": <the Turn number it comes from>, "snippet": "<short quote>"}. Use only Turn numbers that appear below. Never invent turns.
2. NO FALSE DEAD-ENDS (FR-05, FR-20): do NOT record transient network failures, rate limits, timeouts or syntax/typo mistakes as deadEnds. Only architectural or incompatibility failures qualify, and each MUST have "retryConditions".
3. SUPERSEDES: if a decision replaces an earlier known decision, put that decision's id in "supersedes"; otherwise [].
4. Do NOT put ids, sessionId, timestamps or hashes in records; the system assigns them.
5. Record only what the transcript actually shows. Empty arrays are fine.

OUTPUT: valid JSON only (no prose, no code fences), exactly this shape:
{
  "decisions": [{"title": str, "context": str, "choice": str, "consequences": str?, "decidedBy": "user"|"agent", "author": "user"|"agent"|"team", "affectsModules": [str], "supersedes": [str], "confidence": "high"|"medium"|"low", "evidence": {...}}],
  "rcas": [{"title": str, "incident": str, "rootCause": str, "resolution": str, "preventativeActions": [str], "affectsFiles": [str], "confidence": "high"|"medium"|"low", "evidence": {...}}],
  "deadEnds": [{"title": str, "rootCauseType": "architectural"|"limitation"|"incompatibility", "approach": str, "whyFailed": str, "retryConditions": str, "affectsModules": [str], "confidence": "high"|"medium"|"low", "evidence": {...}}],
  "tasks": [{"title": str, "summary": str, "filesModified": [str], "status": "completed"|"in_progress"|"abandoned", "evidence": {...}}]
}

TRANSCRIPT TURNS:
${formattedEvents}
`;
  }

  /**
   * Extracts typed records using the LLM client (or heuristic fallback) and compiles them.
   */
  public async extractAndCompile(sessionFilePath: string): Promise<ExtractedBundle> {
    const events = this.readSessionEvents(sessionFilePath);
    if (events.length === 0) {
      return { decisions: [], rcas: [], deadEnds: [], tasks: [] };
    }

    const prompt = this.buildCompilerPrompt(events);
    const bundle = await this.llmClient.extract(prompt, events);
    this.compileSession(sessionFilePath, bundle);
    return bundle;
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

    const recentDeadEnds = this.storage.wiki
      .listDeadEnds()
      .filter((d) => ok(d.confidence) && d.status !== 'draft')
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
      .filter((x) => x.status === 'active' && ok(x.confidence) && !x.supersededBy)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((d) => ({
        id: d.id,
        title: d.title.slice(0, 80),
        choice: d.choice.slice(0, 180),
        affectsModules: d.affectsModules,
      }));

    const recentRCAs = this.storage.wiki
      .listRCAs()
      .filter((x) => ok(x.confidence) && x.status !== 'draft')
      .slice(-3)
      .reverse()
      .map((r) => ({
        id: r.id,
        title: r.title.slice(0, 80),
        incident: r.incident.slice(0, 120),
        resolution: r.resolution.slice(0, 120),
      }));

    const build = () => ({ version: 1, lastUpdated: new Date().toISOString(), activeDecisions, recentDeadEnds, recentRCAs, estimatedTokens: 0 });
    const measure = () => {
      const text = formatPushText(build(), Number.MAX_SAFE_INTEGER);
      return text ? countTokens(text) : 0;
    };

    // Drop the least valuable item until the injected text fits: RCAs, then decisions, then dead ends.
    let tokens = measure();
    while (tokens > maxTokens && (recentRCAs.length || activeDecisions.length || recentDeadEnds.length)) {
      if (recentRCAs.length) recentRCAs.pop();
      else if (activeDecisions.length) activeDecisions.pop();
      else recentDeadEnds.pop();
      tokens = measure();
    }

    this.storage.cache.setActiveContext({ ...build(), estimatedTokens: tokens });
  }
}
