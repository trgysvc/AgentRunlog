import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type Run, type RawSessionEvent } from '../types/schemas.js';
import { analyzeSession, runKind, type RunKind } from './journey.js';
import { type StorageManager } from '../storage/index.js';

export interface LastSession {
  sessionId: string;
  at: string;
  text: string;
  openWork: boolean;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * Handoff (deterministic, no model): what the last session was about, which files it touched and
 * what is still open. Capped at ~400 chars so it fits the NFR-07 push budget. Built from whatever
 * raw events exist, so it works for 25-turn / PreCompact / crash-recovery compiles, not only SessionEnd.
 */
export function buildLastSession(events: RawSessionEvent[], lastRun?: Run): LastSession | null {
  const a = analyzeSession(events);
  if (!a || a.requests.length === 0) return null;
  const openFailures = [...a.open.keys()];
  const lastRunFailed = lastRun ? lastRun.exitCode !== 0 : false;
  const openWork = openFailures.length > 0 || lastRunFailed;
  const asked = clip(a.requests[a.requests.length - 1].text, 110);
  const files = [...a.files.keys()].slice(-4).map((f) => f.split('/').slice(-2).join('/'));
  const parts = [`Asked: "${asked}".`];
  if (files.length) parts.push(`Touched ${files.join(', ')}.`);
  if (openFailures.length) parts.push(`OPEN: \`${clip(openFailures[0], 60)}\` still failing.`);
  else if (lastRunFailed && lastRun) parts.push(`OPEN: last run \`${clip(lastRun.command, 50)}\` failed.`);
  else parts.push('No open failures.');
  if (a.unverifiedClaims.length) parts.push(`Unverified claim: ${a.unverifiedClaims.join('/')}.`);
  return { sessionId: a.sessionId, at: a.last, text: clip(parts.join(' '), 400), openWork };
}

/** Latest passing test/build/lint/typecheck Run per kind, as short push lines. */
export function verifiedCommands(runs: Run[]): string[] {
  const best = new Map<RunKind, Run>();
  for (const r of runs) {
    if (r.exitCode !== 0) continue;
    const k = runKind(r.command);
    if (!k) continue;
    const cur = best.get(k);
    if (!cur || r.createdAt > cur.createdAt) best.set(k, r);
  }
  return (['test', 'build', 'lint', 'typecheck'] as RunKind[])
    .filter((k) => best.has(k))
    .map((k) => `${k}: \`${clip(best.get(k)!.command, 70)}\` passed (${best.get(k)!.createdAt.slice(0, 10)})`);
}

/** Git commits within [from, to] (git log --since/--until). Silently empty without a repo or git. */
export function gitCommits(projectRoot: string, from: string, to: string): string[] {
  try {
    if (!existsSync(join(projectRoot, '.git'))) return [];
    const out = execFileSync('git', ['log', `--since=${from}`, `--until=${to}`, '--format=%h %s', '-n', '20'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => clip(l, 100));
  } catch {
    return [];
  }
}

/** Persist the handoff of the most recent session (by event time) in cache/last_session.json. */
export function saveLastSession(storage: StorageManager, ls: LastSession): void {
  try {
    const file = join(storage.paths.cache, 'last_session.json');
    mkdirSync(storage.paths.cache, { recursive: true });
    if (existsSync(file)) {
      const cur = JSON.parse(readFileSync(file, 'utf8'));
      if (cur?.at && cur.at > ls.at) return;
    }
    writeFileSync(file, JSON.stringify(ls), 'utf8');
  } catch {}
}

export function loadLastSession(storage: StorageManager): LastSession | null {
  try {
    return JSON.parse(readFileSync(join(storage.paths.cache, 'last_session.json'), 'utf8'));
  } catch {
    return null;
  }
}

const looksLikePath = (p: string) => /[\\/]/.test(p) || /\.[A-Za-z0-9]{1,5}$/.test(p);

/**
 * Code sync: a cited path is "gone" when its parent directory exists but the file/dir itself does not
 * (a deleted or renamed file). A project that simply lacks the directory is not treated as stale.
 */
export function pathIsGone(projectRoot: string, ref: string): boolean {
  const clean = ref.replace(/\/\*\*?$/, '').replace(/^\.\//, '');
  if (!clean || !looksLikePath(clean) || clean.includes('*')) return false;
  const abs = isAbsolute(clean) ? clean : join(projectRoot, clean);
  if (existsSync(abs)) return false;
  const parent = abs.slice(0, Math.max(abs.lastIndexOf('/'), 0));
  return parent.length > 0 && existsSync(parent);
}

/** Ids of records whose every cited file is gone. They are kept in the wiki but not pushed. */
export function staleRecordIds(storage: StorageManager, projectRoot: string): Set<string> {
  const out = new Set<string>();
  const check = (id: string, refs: string[]) => {
    const pathRefs = refs.filter((r) => looksLikePath(r.replace(/\/\*\*?$/, '')));
    if (pathRefs.length > 0 && pathRefs.every((r) => pathIsGone(projectRoot, r))) out.add(id);
  };
  for (const d of storage.wiki.listDecisions()) check(d.id, d.affectsModules);
  for (const d of storage.wiki.listDeadEnds()) check(d.id, d.affectsModules);
  for (const r of storage.wiki.listRCAs()) check(r.id, r.affectsFiles);
  return out;
}
