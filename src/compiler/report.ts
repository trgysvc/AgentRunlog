import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { WikiLinter } from './linter.js';
import { analyzeSession } from './journey.js';

export interface ImpactReport {
  sessions: number;
  platforms: Record<string, number>;
  injections: number;
  activeDecisions: number;
  draftDecisions: number;
  supersededDecisions: number;
  rcas: number;
  deadEnds: number;
  runs: number;
  repeatedFailures: { command: string; sessions: number }[];
  unverifiedClaims: number;
  staleRecords: number;
  lintErrors: number;
  lintWarnings: number;
}

/** Deterministic impact report (candidate feature "Etki raporu"): what the memory captured and how often it was injected. */
export function buildImpactReport(storage: StorageManager): ImpactReport {
  const { paths, wiki } = storage;
  const platforms: Record<string, number> = {};
  const failSessions = new Map<string, Set<string>>();
  let sessions = 0;
  let injections = 0;
  let unverifiedClaims = 0;
  const files = existsSync(paths.raw) ? readdirSync(paths.raw).filter((f) => f.startsWith('session-') && f.endsWith('.jsonl')) : [];
  for (const f of files) {
    sessions++;
    const seen = new Set<string>();
    const evs: any[] = [];
    for (const line of readFileSync(join(paths.raw, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        evs.push(e);
        if (!seen.has(e.platform)) {
          seen.add(e.platform);
          platforms[e.platform] = (platforms[e.platform] || 0) + 1;
        }
        if (e.eventType === 'session_start' && !e.payload?.imported) injections++;
        const p = e.payload || {};
        const failed = p.hook_event_name === 'PostToolUseFailure' || (typeof p.error === 'string' && p.error);
        const cmd = p.tool_input?.command;
        if (failed && typeof cmd === 'string') {
          const key = cmd.trim().slice(0, 120);
          if (!failSessions.has(key)) failSessions.set(key, new Set());
          failSessions.get(key)!.add(f);
        }
      } catch {}
    }
    try {
      if ((analyzeSession(evs)?.unverifiedClaims.length ?? 0) > 0) unverifiedClaims++;
    } catch {}
  }
  const decisions = wiki.listDecisions();
  const lint = new WikiLinter(storage).lint();
  return {
    sessions,
    platforms,
    injections,
    activeDecisions: decisions.filter((d) => d.status === 'active').length,
    draftDecisions: decisions.filter((d) => d.status === 'draft').length,
    supersededDecisions: decisions.filter((d) => d.status === 'superseded').length,
    rcas: wiki.listRCAs().length,
    deadEnds: wiki.listDeadEnds().length,
    runs: existsSync(paths.runs) ? readdirSync(paths.runs).filter((f) => f.startsWith('RUN-')).length : 0,
    repeatedFailures: [...failSessions.entries()]
      .filter(([, s]) => s.size >= 2)
      .map(([command, s]) => ({ command, sessions: s.size }))
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 5),
    unverifiedClaims,
    staleRecords: lint.issues.filter((i) => i.code === 'STALE_CODE_REF').length,
    lintErrors: lint.issueCount.errors,
    lintWarnings: lint.issueCount.warnings,
  };
}
