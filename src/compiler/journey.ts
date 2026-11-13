import { type RawSessionEvent } from '../types/schemas.js';
import { normalizeToolPayload } from './heuristic.js';
import { isNonStructuralFailure } from './evidence.js';

const EDIT_TOOLS = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create|replace)/i;
const SHOW_PROMPT_CHARS = 600;

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}… (full text in raw/)` : one;
};

function filesOf(p: Record<string, any>): string[] {
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const out = [input.file_path, input.path, input.notebook_path, p.file, p.file_path, p.path].filter(
    (x): x is string => typeof x === 'string' && x.length > 0
  );
  return out;
}

/**
 * Deterministic "how did the work go" page for one session (no model): what was asked, which files
 * were touched, which commands ran, and which failures were later resolved. Full text always stays
 * in raw/; this is a navigable summary that points back to it by turn number.
 */
export function buildSessionJourney(events: RawSessionEvent[]): string | null {
  if (events.length === 0) return null;
  const sessionId = events[0].sessionId;
  const platform = events[0].platform;
  const first = events[0].timestamp;
  const last = events[events.length - 1].timestamp;

  const requests: Array<{ turn: number; text: string }> = [];
  const files = new Map<string, number>();
  const commands: Array<{ turn: number; cmd: string; failed: boolean }> = [];
  const fixes: Array<{ cmd: string; error: string; failTurn: number; fixTurn: number; edited: string[] }> = [];
  const open = new Map<string, { error: string; turn: number; edited: Set<string> }>();
  let lastResponse = '';
  let toolRuns = 0;

  events.forEach((e, i) => {
    const turn = i + 1;
    const p = normalizeToolPayload(e.payload || {});
    if (e.eventType === 'prompt_submit') {
      const t = String(p.text || p.prompt || p.rawText || '').trim();
      if (t) requests.push({ turn, text: t });
    } else if (e.eventType === 'agent_response') {
      const t = String(p.text || p.message || p.response || p.last_assistant_message || '').trim();
      if (t) lastResponse = t;
    } else if (e.eventType === 'post_tool_use') {
      toolRuns++;
      const tool = String(p.tool || '');
      const isEdit = EDIT_TOOLS.test(tool);
      if (isEdit) {
        for (const f of filesOf(p)) {
          files.set(f, (files.get(f) || 0) + 1);
          for (const o of open.values()) o.edited.add(f);
        }
      }
      if (/^(bash|shell|run|exec)/i.test(tool) || (p.command && !isEdit)) {
        const cmd = String(p.command || tool);
        const failed = Boolean(p.error) || (p.exitCode !== undefined && p.exitCode !== 0);
        commands.push({ turn, cmd, failed });
        if (failed) {
          const err = String(p.error || `exit code ${p.exitCode}`);
          if (!isNonStructuralFailure(err) && !open.has(cmd)) open.set(cmd, { error: err, turn, edited: new Set() });
        } else if (open.has(cmd)) {
          const o = open.get(cmd)!;
          fixes.push({ cmd, error: o.error, failTurn: o.turn, fixTurn: turn, edited: [...o.edited] });
          open.delete(cmd);
        }
      }
    }
  });

  const L: string[] = [
    `# Session Journey: \`${sessionId}\``,
    '',
    `> Auto-generated, deterministic (no model). Full conversation text lives in \`raw/session-${sessionId}.jsonl\`; turn numbers below are line numbers in that file.`,
    '',
    `- **Platform:** ${platform}`,
    `- **Span:** ${first} → ${last}`,
    `- **Events:** ${events.length} (${requests.length} user requests, ${toolRuns} tool runs, ${commands.filter((c) => c.failed).length} failed commands)`,
    '',
    '## What was asked',
    ...(requests.length ? requests.map((r) => `${requests.indexOf(r) + 1}. (turn ${r.turn}) ${clip(r.text, SHOW_PROMPT_CHARS)}`) : ['_No user prompts captured._']),
    '',
  ];
  if (files.size) {
    L.push('## Files changed');
    for (const [f, n] of files) L.push(`- \`${f}\`${n > 1 ? ` ×${n}` : ''}`);
    L.push('');
  }
  if (commands.length) {
    L.push('## Commands run');
    const shown = commands.slice(0, 40);
    for (const c of shown) L.push(`- (turn ${c.turn}) ${c.failed ? '❌' : '✓'} \`${clip(c.cmd, 160)}\``);
    if (commands.length > shown.length) L.push(`- … ${commands.length - shown.length} more in raw/`);
    L.push('');
  }
  if (fixes.length || open.size) {
    L.push('## Errors and how they were resolved');
    for (const f of fixes) {
      L.push(`- \`${clip(f.cmd, 100)}\` failed at turn ${f.failTurn} (${clip(f.error, 160)}) → passed at turn ${f.fixTurn}${f.edited.length ? `, after editing ${f.edited.map((x) => `\`${x}\``).join(', ')}` : ''}`);
    }
    for (const [cmd, o] of open) L.push(`- \`${clip(cmd, 100)}\` failed at turn ${o.turn} (${clip(o.error, 160)}) → **not resolved in this session**`);
    L.push('');
  }
  if (lastResponse) {
    L.push('## How it ended', clip(lastResponse, 800), '');
  }
  return L.join('\n');
}
