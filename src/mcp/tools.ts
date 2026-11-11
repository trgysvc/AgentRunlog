import { StorageManager } from '../storage/index.js';
import { type Decision, type RCA, type DeadEnd } from '../types/schemas.js';

export interface SearchRunlogParams {
  query: string;
  types?: ('decision' | 'rca' | 'dead_end' | 'task' | 'run')[];
  module?: string;
  includeSuperseded?: boolean;
  projectRoot?: string;
}

export interface CheckDeadEndsParams {
  approach: string;
  module?: string;
  projectRoot?: string;
}

const STOP_WORDS = new Set([
  'use', 'the', 'and', 'for', 'with', 'run', 'try', 'inside', 'this', 'that', 'from',
  'into', 'then', 'will', 'make', 'just', 'some', 'test', 'using'
]);

export class RunlogMcpTools {
  private defaultStorage?: StorageManager;
  private storageCache = new Map<string, StorageManager>();

  constructor(storage?: StorageManager) {
    this.defaultStorage = storage;
  }

  private getStorage(projectRoot?: string): StorageManager {
    const targetRoot = projectRoot || process.env.AGENTRUNLOG_PROJECT_ROOT;
    if (targetRoot) {
      let cached = this.storageCache.get(targetRoot);
      if (!cached) {
        cached = new StorageManager(targetRoot);
        this.storageCache.set(targetRoot, cached);
      }
      return cached;
    }
    if (!this.defaultStorage) {
      this.defaultStorage = new StorageManager();
    }
    return this.defaultStorage;
  }

  /**
   * Search across typed records with keyword & module filtering (FR-13, FR-14)
   */
  public searchRunlog(params: SearchRunlogParams): {
    results: Array<{
      type: string;
      id: string;
      title: string;
      status?: string;
      summary: string;
      evidenceSession?: string;
    }>;
    total: number;
  } {
    const storage = this.getStorage(params.projectRoot);
    const q = (params.query || '').toLowerCase().trim();
    const queryTokens = q.split(/\s+/).filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    const types = params.types && params.types.length > 0
      ? params.types
      : ['decision', 'rca', 'dead_end', 'task', 'run'];

    const matches: Array<{
      type: string;
      id: string;
      title: string;
      status?: string;
      summary: string;
      evidenceSession?: string;
      score: number;
    }> = [];

    // 1. Decisions
    if (types.includes('decision')) {
      const decisions = storage.wiki.listDecisions();
      for (const dec of decisions) {
        if (!params.includeSuperseded && dec.status === 'superseded') {
          continue;
        }
        if (params.module && dec.affectsModules.length > 0) {
          const modMatch = dec.affectsModules.some((m) =>
            m.includes(params.module!) || params.module!.includes(m.replace('/**', ''))
          );
          if (!modMatch) continue;
        }

        const searchable = `${dec.id} ${dec.title} ${dec.context} ${dec.choice} ${dec.decidedBy} ${dec.affectsModules.join(' ')}`.toLowerCase();
        const score = this.calculateMatchScore(searchable, queryTokens);
        if (score > 0 || queryTokens.length === 0) {
          matches.push({
            type: 'decision',
            id: dec.id,
            title: dec.title,
            status: dec.status,
            summary: `Choice: ${dec.choice} (Decided by: ${dec.decidedBy})`,
            evidenceSession: dec.evidence.sessionId,
            score,
          });
        }
      }
    }

    // 2. RCA
    if (types.includes('rca')) {
      const rcas = storage.wiki.listRCAs();
      for (const rca of rcas) {
        if (params.module && rca.affectsFiles.length > 0) {
          const modMatch = rca.affectsFiles.some((f) => f.includes(params.module!));
          if (!modMatch) continue;
        }
        const searchable = `${rca.id} ${rca.title} ${rca.incident} ${rca.rootCause} ${rca.resolution}`.toLowerCase();
        const score = this.calculateMatchScore(searchable, queryTokens);
        if (score > 0 || queryTokens.length === 0) {
          matches.push({
            type: 'rca',
            id: rca.id,
            title: rca.title,
            summary: `Cause: ${rca.rootCause} | Fix: ${rca.resolution}`,
            evidenceSession: rca.evidence.sessionId,
            score,
          });
        }
      }
    }

    // 3. Dead Ends
    if (types.includes('dead_end')) {
      const deadEnds = storage.wiki.listDeadEnds();
      for (const de of deadEnds) {
        if (params.module && de.affectsModules.length > 0) {
          const modMatch = de.affectsModules.some((m) =>
            m.includes(params.module!) || params.module!.includes(m.replace('/**', ''))
          );
          if (!modMatch) continue;
        }
        const searchable = `${de.id} ${de.title} ${de.approach} ${de.whyFailed} ${de.retryConditions}`.toLowerCase();
        const score = this.calculateMatchScore(searchable, queryTokens);
        if (score > 0 || queryTokens.length === 0) {
          matches.push({
            type: 'dead_end',
            id: de.id,
            title: de.title,
            summary: `Why failed: ${de.whyFailed} | Retry when: ${de.retryConditions}`,
            evidenceSession: de.evidence.sessionId,
            score,
          });
        }
      }
    }

    matches.sort((a, b) => b.score - a.score);
    return {
      results: matches.map(({ score, ...item }) => item),
      total: matches.length,
    };
  }

  /**
   * Retrieve single Decision with full context and supersede graph (FR-07)
   */
  public getDecision(id: string, projectRoot?: string): Decision | null {
    const storage = this.getStorage(projectRoot);
    const decisions = storage.wiki.listDecisions();
    return decisions.find((d) => d.id.toLowerCase() === id.toLowerCase()) || null;
  }

  /**
   * Retrieve single RCA record
   */
  public getRCA(id: string, projectRoot?: string): RCA | null {
    const storage = this.getStorage(projectRoot);
    const rcas = storage.wiki.listRCAs();
    return rcas.find((r) => r.id.toLowerCase() === id.toLowerCase()) || null;
  }

  /**
   * Check intended approach against known Dead Ends with Soft Guardrail (FR-18, FR-20)
   */
  public checkDeadEnds(params: CheckDeadEndsParams): {
    hasKnownFailures: boolean;
    warningMessage?: string;
    deadEnds: Array<{
      id: string;
      title: string;
      approach: string;
      whyFailed: string;
      retryConditions: string;
      rootCauseType: string;
    }>;
  } {
    const storage = this.getStorage(params.projectRoot);
    const approachTokens = (params.approach || '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

    const allDeadEnds = storage.wiki.listDeadEnds();
    const relevant: Array<DeadEnd & { matchScore: number }> = [];

    for (const de of allDeadEnds) {
      if (params.module && de.affectsModules.length > 0) {
        const modMatch = de.affectsModules.some((m) =>
          m.includes(params.module!) || params.module!.includes(m.replace('/**', ''))
        );
        if (!modMatch) continue;
      }

      const searchable = `${de.title} ${de.approach} ${de.whyFailed}`.toLowerCase();
      const score = this.calculateMatchScore(searchable, approachTokens);
      if (score >= 2) {
        relevant.push({ ...de, matchScore: score });
      }
    }

    relevant.sort((a, b) => b.matchScore - a.matchScore);

    if (relevant.length === 0) {
      return {
        hasKnownFailures: false,
        deadEnds: [],
      };
    }

    const warningLines = [
      `⚠️ WARNING: ${relevant.length} prior failed attempt(s) found related to this approach.`,
      `This is a non-blocking advisory. You may proceed ONLY IF your approach satisfies the retry conditions:`,
      ...relevant.map(
        (r) =>
          `- [${r.id}] "${r.title}": Failed because "${r.whyFailed}". Viable retry condition: "${r.retryConditions}"`
      ),
    ];

    return {
      hasKnownFailures: true,
      warningMessage: warningLines.join('\n'),
      deadEnds: relevant.map((r) => ({
        id: r.id,
        title: r.title,
        approach: r.approach,
        whyFailed: r.whyFailed,
        retryConditions: r.retryConditions,
        rootCauseType: r.rootCauseType,
      })),
    };
  }

  /**
   * Fetch pre-compiled active context (FR-19, sub-5ms)
   */
  public getActiveContext(projectRoot?: string): string {
    const storage = this.getStorage(projectRoot);
    const cache = storage.cache.getActiveContext();
    const formatted = storage.cache.formatPushInjection(cache);
    return formatted || 'No active decisions, recent RCAs, or known dead ends recorded yet.';
  }

  /**
   * Record a new engineering Decision directly from an active session (FR-03, FR-07)
   */
  public recordDecision(params: {
    title: string;
    context: string;
    choice: string;
    consequences?: string;
    decidedBy?: string;
    supersedes?: string[];
    affectsModules?: string[];
    sessionId?: string;
    projectRoot?: string;
  }): Decision {
    const storage = this.getStorage(params.projectRoot);
    const existing = storage.wiki.listDecisions();
    const nextNum = existing.length + 1;
    const id = `DEC-${String(nextNum).padStart(3, '0')}`;
    const now = new Date().toISOString();

    const supersedesList = params.supersedes || [];
    for (const oldId of supersedesList) {
      const oldDec = existing.find((d) => d.id.toLowerCase() === oldId.toLowerCase());
      if (oldDec) {
        oldDec.status = 'superseded';
        oldDec.supersededBy = id;
        oldDec.updatedAt = now;
        storage.wiki.saveDecision(oldDec);
      }
    }

    const decision: Decision = {
      id,
      title: params.title,
      status: 'active',
      decidedBy: params.decidedBy || 'user',
      author: 'team',
      context: params.context,
      choice: params.choice,
      consequences: params.consequences,
      supersedes: supersedesList,
      supersededBy: null,
      affectsModules: params.affectsModules || [],
      evidence: {
        sessionId: params.sessionId || `live_${Date.now()}`,
        timestamp: now,
      },
      confidence: 'high',
      createdAt: now,
      updatedAt: now,
    };

    storage.wiki.saveDecision(decision);
    storage.wiki.generateIndexAndModules();
    this.refreshCacheFromWiki(storage);
    return decision;
  }

  /**
   * Record a structural DeadEnd directly from an active session (FR-05, FR-20)
   */
  public recordDeadEnd(params: {
    title: string;
    approach: string;
    whyFailed: string;
    retryConditions: string;
    rootCauseType?: 'architectural' | 'limitation' | 'incompatibility';
    affectsModules?: string[];
    sessionId?: string;
    projectRoot?: string;
  }): DeadEnd {
    const storage = this.getStorage(params.projectRoot);
    const existing = storage.wiki.listDeadEnds();
    const nextNum = existing.length + 1;
    const id = `DEAD-${String(nextNum).padStart(3, '0')}`;
    const now = new Date().toISOString();

    const deadEnd: DeadEnd = {
      id,
      title: params.title,
      rootCauseType: params.rootCauseType || 'architectural',
      approach: params.approach,
      whyFailed: params.whyFailed,
      retryConditions: params.retryConditions,
      affectsModules: params.affectsModules || [],
      evidence: {
        sessionId: params.sessionId || `live_${Date.now()}`,
        timestamp: now,
      },
      confidence: 'high',
      createdAt: now,
    };

    storage.wiki.saveDeadEnd(deadEnd);
    storage.wiki.generateIndexAndModules();
    this.refreshCacheFromWiki(storage);
    return deadEnd;
  }

  /**
   * Record a Root Cause Analysis directly from an active session (FR-04, FR-05)
   */
  public recordRCA(params: {
    title: string;
    incident: string;
    rootCause: string;
    resolution: string;
    preventativeActions?: string[];
    affectsFiles?: string[];
    sessionId?: string;
    projectRoot?: string;
  }): RCA {
    const storage = this.getStorage(params.projectRoot);
    const existing = storage.wiki.listRCAs();
    const nextNum = existing.length + 1;
    const id = `RCA-${String(nextNum).padStart(3, '0')}`;
    const now = new Date().toISOString();

    const rca: RCA = {
      id,
      title: params.title,
      incident: params.incident,
      rootCause: params.rootCause,
      resolution: params.resolution,
      preventativeActions: params.preventativeActions || [],
      affectsFiles: params.affectsFiles || [],
      evidence: {
        sessionId: params.sessionId || `live_${Date.now()}`,
        timestamp: now,
      },
      confidence: 'high',
      createdAt: now,
    };

    storage.wiki.saveRCA(rca);
    storage.wiki.generateIndexAndModules();
    this.refreshCacheFromWiki(storage);
    return rca;
  }

  private refreshCacheFromWiki(storage: StorageManager): void {
    const allDecisions = storage.wiki.listDecisions();
    const allDeadEnds = storage.wiki.listDeadEnds();
    const allRCAs = storage.wiki.listRCAs();

    const activeDecisions = allDecisions
      .filter((d) => d.status === 'active' && d.confidence !== 'low' && !d.supersededBy)
      .slice(0, 10)
      .map((d) => ({
        id: d.id,
        title: d.title,
        choice: d.choice,
        affectsModules: d.affectsModules,
      }));

    const recentDeadEnds = allDeadEnds
      .filter((d) => d.confidence !== 'low')
      .slice(0, 5)
      .map((de) => ({
        id: de.id,
        title: de.title,
        approach: de.approach,
        whyFailed: de.whyFailed,
        retryConditions: de.retryConditions,
        affectsModules: de.affectsModules,
      }));

    const recentRCAs = allRCAs
      .filter((r) => r.confidence !== 'low')
      .slice(-3)
      .map((r) => ({
        id: r.id,
        title: r.title,
        incident: r.incident.slice(0, 150),
        resolution: r.resolution.slice(0, 150),
      }));

    const rawLength =
      JSON.stringify(activeDecisions).length +
      JSON.stringify(recentDeadEnds).length +
      JSON.stringify(recentRCAs).length;

    storage.cache.setActiveContext({
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeDecisions,
      recentDeadEnds,
      recentRCAs,
      estimatedTokens: Math.ceil(rawLength / 4),
    });
  }

  private calculateMatchScore(text: string, tokens: string[]): number {
    let score = 0;
    for (const token of tokens) {
      const wordRegex = new RegExp(`\\b${token}\\b`, 'i');
      if (wordRegex.test(text)) {
        score += 2;
      } else if (token.length >= 4 && text.includes(token)) {
        score += 1;
      }
    }
    return score;
  }
}
