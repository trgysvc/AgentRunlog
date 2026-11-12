import { createHash } from 'node:crypto';
import { type Evidence } from '../types/schemas.js';

/** FR-06: a transcript-backed record needs sessionId + turnIndex + line + hash. */
export function hasCompleteEvidence(ev: Partial<Evidence> | undefined): boolean {
  return !!ev && !!ev.sessionId && typeof ev.turnIndex === 'number' && typeof ev.line === 'number' && !!ev.hash;
}

/** Stable short hash of a raw event, so evidence can be re-verified against the JSONL line. */
export function eventHash(event: unknown): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 16);
}

const TRANSIENT_FAILURE =
  /\b(50[234]|429)\b|timed out|etimedout|(?:request|connection|socket|gateway|read|network) time-?out|econn(?:reset|refused|aborted)|enotfound|eai_again|socket hang up|rate.?limit|temporar(?:y|ily) unavailable|service unavailable|network (?:error|unreachable)/i;
const SIMPLE_SYNTAX_ERROR = /syntaxerror|syntax error|unexpected token|unexpected end of|parse error|command not found|no such file or directory/i;

/**
 * FR-05: only architectural/structural failures may become DeadEnds.
 * Transient network errors and plain syntax/typo errors never qualify.
 */
export function isNonStructuralFailure(text: string): boolean {
  return TRANSIENT_FAILURE.test(text) || SIMPLE_SYNTAX_ERROR.test(text);
}
