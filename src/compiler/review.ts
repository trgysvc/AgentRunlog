import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';
import { type Decision } from '../types/schemas.js';

/**
 * Opt-in decision-conflict review (default OFF).
 *
 * AgentRunlog never calls a model. When the user enables this, the compiler only *selects candidate
 * pairs* deterministically (two active decisions that affect the same module) and the push context
 * asks the user's own working agent to compare them and report the verdict through the
 * `review_decision_conflict` MCP tool. That spends the working agent's tokens, which is why it needs
 * explicit consent (`runlog llm-review enable`).
 */

export const MAX_REVIEW_PAIRS = 2;

const pairKey = (a: string, b: string) => [a, b].sort().join('|');

function reviewedFile(storage: StorageManager) {
  return join(storage.paths.cache, 'reviewed_pairs.json');
}

export function loadReviewed(storage: StorageManager): Set<string> {
  try {
    const f = reviewedFile(storage);
    return new Set(existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveReviewed(storage: StorageManager, set: Set<string>) {
  mkdirSync(storage.paths.cache, { recursive: true });
  writeFileSync(reviewedFile(storage), JSON.stringify([...set]), 'utf8');
}

export function isLlmReviewEnabled(storage: StorageManager): boolean {
  return storage.config.llmReview?.enabled === true;
}

export interface ReviewPair {
  a: { id: string; title: string; choice: string };
  b: { id: string; title: string; choice: string };
}

/** Deterministic candidates: active, non-draft decisions sharing a module, not reviewed yet. */
export function conflictCandidates(storage: StorageManager): ReviewPair[] {
  if (!isLlmReviewEnabled(storage)) return [];
  const reviewed = loadReviewed(storage);
  const active = storage.wiki
    .listDecisions()
    .filter((d) => d.status === 'active' && !d.supersededBy)
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const out: ReviewPair[] = [];
  const slim = (d: Decision) => ({ id: d.id, title: d.title.slice(0, 60), choice: d.choice.slice(0, 110) });
  for (let i = 0; i < active.length && out.length < MAX_REVIEW_PAIRS; i++) {
    for (let j = i + 1; j < active.length && out.length < MAX_REVIEW_PAIRS; j++) {
      const A = active[i], B = active[j];
      if (A.supersedes.includes(B.id) || B.supersedes.includes(A.id)) continue;
      if (reviewed.has(pairKey(A.id, B.id))) continue;
      const shared = A.affectsModules.some((m) => m && B.affectsModules.includes(m));
      if (shared) out.push({ a: slim(A), b: slim(B) });
    }
  }
  return out;
}

/** Applies the working agent's verdict. A conflict needs a winner; the loser becomes superseded. */
export function applyReviewVerdict(
  storage: StorageManager,
  idA: string,
  idB: string,
  verdict: 'conflict' | 'compatible',
  winner?: string
): string {
  if (!isLlmReviewEnabled(storage)) {
    throw new Error('LLM conflict review is disabled. The user can enable it with `runlog llm-review enable`.');
  }
  const decisions = storage.wiki.listDecisions();
  const A = decisions.find((d) => d.id === idA);
  const B = decisions.find((d) => d.id === idB);
  if (!A || !B) throw new Error(`Decision not found: ${!A ? idA : idB}`);

  const reviewed = loadReviewed(storage);
  if (verdict === 'compatible') {
    reviewed.add(pairKey(A.id, B.id));
    saveReviewed(storage, reviewed);
    return `Marked ${A.id} and ${B.id} as compatible; they will not be asked again.`;
  }
  if (winner !== A.id && winner !== B.id) throw new Error('verdict "conflict" requires winner to be one of the two decision ids.');
  const win = winner === A.id ? A : B;
  const lose = win === A ? B : A;
  const now = new Date().toISOString();
  if (!win.supersedes.includes(lose.id)) win.supersedes.push(lose.id);
  win.updatedAt = now;
  storage.wiki.saveDecision(win);
  lose.status = 'superseded';
  lose.supersededBy = win.id;
  lose.updatedAt = now;
  storage.wiki.saveDecision(lose);
  reviewed.add(pairKey(A.id, B.id));
  saveReviewed(storage, reviewed);
  return `${lose.id} is now superseded by ${win.id}.`;
}
