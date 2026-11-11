import { type StorageManager } from '../storage/index.js';
import { type Decision, type RCA, type DeadEnd } from '../types/schemas.js';

export interface SearchRunlogParams {
  query: string;
  types?: ('decision' | 'rca' | 'dead_end' | 'task' | 'run')[];
  module?: string;
  includeSuperseded?: boolean;
}

export interface CheckDeadEndsParams {
  approach: string;
  module?: string;
}

const STOP_WORDS = new Set([
  'use', 'the', 'and', 'for', 'with', 'run', 'try', 'inside', 'this', 'that', 'from',
  'into', 'then', 'will', 'make', 'just', 'some', 'test', 'using'
]);

export class RunlogMcpTools {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
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
      const decisions = this.storage.wiki.listDecisions();
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
      const rcas = this.storage.wiki.listRCAs();
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
      const deadEnds = this.storage.wiki.listDeadEnds();
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
  public getDecision(id: string): Decision | null {
    const decisions = this.storage.wiki.listDecisions();
    return decisions.find((d) => d.id.toLowerCase() === id.toLowerCase()) || null;
  }

  /**
   * Retrieve single RCA record
   */
  public getRCA(id: string): RCA | null {
    const rcas = this.storage.wiki.listRCAs();
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
    const approachTokens = (params.approach || '')
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

    const allDeadEnds = this.storage.wiki.listDeadEnds();
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
      // Require meaningful match score (at least 2 matching points)
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

    // Soft Guardrail Warning Message (FR-20)
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
  public getActiveContext(): string {
    const cache = this.storage.cache.getActiveContext();
    const formatted = this.storage.cache.formatPushInjection(cache);
    return formatted || 'No active decisions or known dead ends recorded yet.';
  }

  private calculateMatchScore(text: string, tokens: string[]): number {
    let score = 0;
    for (const token of tokens) {
      // Whole-word match gets 2 points, substring gets 1 point only if token >= 4 chars
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
