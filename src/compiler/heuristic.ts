import { createHash } from 'node:crypto';
import { type ExtractedBundle } from './extractor.js';
import { type RawSessionEvent } from '../types/schemas.js';
import { eventHash, isNonStructuralFailure } from './evidence.js';

/**
 * Flattens the real per-platform tool payloads (Claude: tool_name/tool_input/tool_response)
 * into the simple shape the heuristic understands. Already-flat payloads pass through.
 */
export function normalizeToolPayload(p: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...p };
  const input = p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {};
  const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
  if (out.command === undefined) out.command = input.command ?? input.file_path ?? undefined;
  if (out.tool === undefined) out.tool = p.tool_name;
  if (out.exitCode === undefined) out.exitCode = resp.exit_code ?? resp.exitCode ?? resp.returncode;
  if (out.error === undefined) {
    if (typeof resp.error === 'string' && resp.error) out.error = resp.error;
    else if (resp.is_error === true || p.is_error === true) out.error = String(resp.stderr || resp.content || resp.stdout || 'Tool reported an error').slice(0, 500);
    else if (typeof resp.stderr === 'string' && resp.stderr && out.exitCode !== undefined && out.exitCode !== 0) out.error = resp.stderr.slice(0, 500);
  }
  return out;
}

function deterministicShortId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 6).toUpperCase();
}

/**
 * Deterministic, offline extraction straight from the captured work (no model is ever called).
 * Automatically scans events for:
 * - Natural language architectural decisions (FR-03)
 * - Repeated consecutive failures -> DeadEnds (FR-05, FR-20)
 * - Single tool crashes -> RCAs (FR-04)
 * - Initial session prompt -> Tasks (FR-02)
 */
const RUN_COMMAND = /\b(npm (run )?(test|build|lint)|pnpm (run )?(test|build|lint)|yarn (test|build|lint)|vitest|jest|pytest|go (test|build|vet)|cargo (test|build|check|clippy)|tsc\b|make( |$)|mvn |gradle|eslint|ruff)\b/i;

export function heuristicExtract(events: RawSessionEvent[]): ExtractedBundle {
  const bundle: ExtractedBundle = {
    decisions: [],
    rcas: [],
    deadEnds: [],
    tasks: [],
    runs: [],
  };

  if (events.length === 0) return bundle;
  const sessionId = events[0].sessionId;
  const isHistoricalImport = sessionId.startsWith('import_') || events.some((e) => e.payload?.imported === true);
  const pendingFixes = new Map<string, { index: number; errMsg: string; timestamp: string; edited: Set<string> }>();
  const failureCounts = new Map<string, { count: number; lastError: string; timestamp: string; turnIndex: number }>();

  const decisionSignalRegex =
    /\b(let'?s use|decided to|we will use|switch to|migrate to|instead of|adopt|use .+ over|kullanalım|kullanacağız|karar|yerine|geçelim|tercih)\b/i;

  const ev = (i: number, timestamp: string) => ({
    sessionId,
    turnIndex: i + 1,
    line: i + 1,
    hash: eventHash(events[i]),
    timestamp,
  });

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const payload = normalizeToolPayload(e.payload || {});
    const promptText = String(payload.text || payload.prompt || payload.rawText || '');

    // 1. Detect natural-language engineering decisions automatically (cap 5 per session)
    // NFR-08: Historical heuristic extractions are marked status: 'draft' and confidence: 'low'
    // so they do NOT pollute push cache until verified.
    if (
      bundle.decisions.length < 5 &&
      e.eventType === 'prompt_submit' &&
      promptText.length > 10 &&
      promptText.length < 500 &&
      decisionSignalRegex.test(promptText)
    ) {
      const cleanSingleLine = promptText.replace(/\s+/g, ' ').trim();
      bundle.decisions.push({
        id: `DEC-${deterministicShortId(`${sessionId}:dec:${i}`)}`,
        title: cleanSingleLine.slice(0, 65),
        status: 'draft', // keyword guess, never trusted: explicit decisions come through record_decision
        decidedBy: 'heuristic-candidate',
        author: 'user',
        context: `User directive captured during session ${sessionId}`,
        choice: cleanSingleLine.slice(0, 280),
        supersedes: [],
        supersededBy: null,
        affectsModules: [],
        evidence: ev(i, e.timestamp),
        confidence: 'low',
        createdAt: e.timestamp,
        updatedAt: e.timestamp,
      });
    }

    // 2. Detect failed tool calls & repeated dead-end failures
    if (e.eventType === 'post_tool_use' && (payload.error || (payload.exitCode !== undefined && payload.exitCode !== 0))) {
      const cmdKey = String(payload.command || payload.tool || 'Tool');
      const errMsg = String(payload.error || `Exit code ${payload.exitCode}`);
      const structural = !isNonStructuralFailure(errMsg);

      const prev = failureCounts.get(cmdKey) || { count: 0, lastError: '', timestamp: e.timestamp, turnIndex: i + 1 };
      prev.count += 1;
      prev.lastError = errMsg;
      prev.timestamp = e.timestamp;
      prev.turnIndex = i + 1;
      if (structural) failureCounts.set(cmdKey, prev);

      if (prev.count === 1 && structural) pendingFixes.set(cmdKey, { index: i, errMsg, timestamp: e.timestamp, edited: new Set() });
    }

    // 2b. A failure only becomes an RCA once it is observed to be resolved: the same command succeeds later.
    //     Unresolved failures stay in the session journey; they are not pushed as "known fixes".
    if (e.eventType === 'post_tool_use') {
      const failedNow = Boolean(payload.error) || (payload.exitCode !== undefined && payload.exitCode !== 0);
      const key = String(payload.command || payload.tool || 'Tool');
      if (!failedNow) {
        if (/^(edit|write|multiedit|notebookedit|str_replace)/i.test(String(payload.tool || ''))) {
          const f = String(payload.command || '');
          if (f) for (const pf of pendingFixes.values()) pf.edited.add(f);
        }
        const pf = pendingFixes.get(key);
        if (pf) {
          pendingFixes.delete(key);
          const files = [...pf.edited];
          bundle.rcas.push({
            id: `RCA-${deterministicShortId(`${sessionId}:rca:${pf.index}`)}`,
            title: `Command Failed: ${key}`.slice(0, 120),
            incident: pf.errMsg,
            rootCause: 'Command returned a non-zero exit code',
            resolution: files.length
              ? `Resolved: the same command succeeded after editing ${files.slice(0, 5).join(', ')}`
              : 'Resolved: the same command succeeded on a later run without file edits (environment or arguments)',
            preventativeActions: [],
            affectsFiles: files.slice(0, 10),
            evidence: ev(pf.index, pf.timestamp),
            confidence: isHistoricalImport ? 'low' : 'medium',
            createdAt: pf.timestamp,
          });
        }
      }
    }

    // 2c. Test / build / lint runs are Run records (FR-04, FR-05): command, exit code and a one-line result.
    if (e.eventType === 'post_tool_use' && RUN_COMMAND.test(String(payload.command || '')) && /^(bash|shell|run|exec)/i.test(String(payload.tool || 'bash'))) {
      const failed = Boolean(payload.error) || (payload.exitCode !== undefined && payload.exitCode !== 0);
      const code = typeof payload.exitCode === 'number' ? payload.exitCode : failed ? 1 : 0;
      const out = String(payload.error || payload.stdout || payload.tool_response?.stdout || payload.tool_response?.content || '');
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      const key = lines.reverse().find((l) => /pass|fail|error|tests?|ok\b|built|success|✓|✗|×/i.test(l)) || lines[0] || (failed ? 'failed' : 'ok');
      bundle.runs!.push({
        id: `RUN-${deterministicShortId(`${sessionId}:run:${i}`)}`,
        command: String(payload.command).slice(0, 300),
        exitCode: code,
        summary: key.slice(0, 300),
        evidence: ev(i, e.timestamp),
        createdAt: e.timestamp,
      });
    }

    // 3. Detect task descriptions from initial prompt
    if (e.eventType === 'prompt_submit' && promptText && bundle.tasks.length === 0) {
      bundle.tasks.push({
        id: `TASK-${deterministicShortId(`${sessionId}:task:${i}`)}`,
        title: promptText.slice(0, 60),
        summary: promptText,
        filesModified: [],
        status: 'completed',
        evidence: ev(i, e.timestamp),
        createdAt: e.timestamp,
      });
    }
  }

  // Promote repeated failures (2+ failures on same command/tool) to a Soft Guardrail DeadEnd
  for (const [cmdKey, stats] of failureCounts.entries()) {
    if (stats.count >= 2) {
      bundle.deadEnds.push({
        id: `DEAD-${deterministicShortId(`${sessionId}:dead:${cmdKey}`)}`,
        title: `Repeated Failure on ${cmdKey}`,
        rootCauseType: 'incompatibility',
        approach: cmdKey,
        whyFailed: `Failed ${stats.count} times in session. Last error: ${stats.lastError}`,
        retryConditions: 'Verify environment configuration, dependencies, or alternative command flags before retrying.',
        affectsModules: [],
        evidence: ev(stats.turnIndex - 1, stats.timestamp),
        confidence: isHistoricalImport ? 'low' : 'medium',
        createdAt: stats.timestamp,
      });
    }
  }

  return bundle;
}
