/**
 * Dependency-free push-context formatter (FR-19, NFR-07).
 * Used by the lightweight hook entry, so it must not import zod or any heavy module.
 */

export interface PushCacheShape {
  activeDecisions?: Array<{ id: string; title: string; choice: string }>;
  recentDeadEnds?: Array<{ id: string; title: string; whyFailed: string; retryConditions: string }>;
  recentRCAs?: Array<{ id: string; title: string; incident: string; resolution: string }>;
}

/** NFR-07: 800 tokens ~= 3,200 characters. */
export const DEFAULT_PUSH_CHAR_BUDGET = 3200;

const REMINDER = '_When the user confirms a lasting choice, call `record_decision` (MCP); before risky changes, call `check_dead_ends`._';

export function formatPushText(cache: PushCacheShape | null, charBudget: number = DEFAULT_PUSH_CHAR_BUDGET): string | null {
  if (!cache) return null;
  const decisions = cache.activeDecisions ?? [];
  const deadEnds = cache.recentDeadEnds ?? [];
  const rcas = cache.recentRCAs ?? [];
  if (decisions.length === 0 && deadEnds.length === 0 && rcas.length === 0) return null;

  const START = '<!-- AGENTRUNLOG_CONTEXT_START -->';
  const END = '<!-- AGENTRUNLOG_CONTEXT_END -->';
  // Section order doubles as priority when the budget runs out: dead ends and decisions first.
  const blocks: Array<{ header: string; lines: string[] }> = [];
  if (decisions.length > 0) {
    blocks.push({
      header: '### 🧠 AgentRunlog Active Decisions:',
      lines: decisions.map((d) => `- **[${d.id}] ${d.title}**: ${d.choice}`),
    });
  }
  if (deadEnds.length > 0) {
    blocks.push({
      header: '### ⚠️ Known Dead Ends (Do Not Repeat):',
      lines: deadEnds.map(
        (de) => `- **[${de.id}] ${de.title}**: Failed because "${de.whyFailed}". Retry condition: ${de.retryConditions}`
      ),
    });
  }
  if (rcas.length > 0) {
    blocks.push({
      header: '### 🔍 Recent Root Cause Analyses (Known Fixes):',
      lines: rcas.map((r) => `- **[${r.id}] ${r.title}**: ${r.incident} → Fix: ${r.resolution}`),
    });
  }

  const out: string[] = [START];
  let used = START.length + END.length + REMINDER.length + 3;
  for (const block of blocks) {
    if (used + block.header.length + 1 > charBudget) break;
    out.push(block.header);
    used += block.header.length + 1;
    for (const line of block.lines) {
      if (used + line.length + 1 > charBudget) break;
      out.push(line);
      used += line.length + 1;
    }
  }
  out.push(REMINDER);
  out.push(END);
  return out.length > 3 ? out.join('\n') : null;
}
