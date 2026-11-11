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

export interface ExtractedBundle {
  decisions: Decision[];
  rcas: RCA[];
  deadEnds: DeadEnd[];
  tasks: Task[];
}

export interface CompilerOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  provider?: 'local' | 'cloud' | 'rule_based';
}

export class TranscriptExtractor {
  private storage: StorageManager;

  constructor(storage: StorageManager) {
    this.storage = storage;
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
    const formattedEvents = events.map((e, idx) => {
      return `Turn ${idx + 1} [${e.eventType} - ${e.timestamp}]:\n${JSON.stringify(e.payload, null, 2)}`;
    }).join('\n\n');

    return `You are the AgentRunlog Compiler Worker. Your job is to transform raw coding agent transcripts into typed engineering memory records in JSON format according to schema.md.

CRITICAL RULES:
1. STRICT EVIDENCE: Every record must reference the turn index and timestamp from the transcript.
2. NO FALSE DEAD-ENDS (FR-05, FR-20): Do NOT record transient network failures, temporary rate limits, or syntax mistakes as DeadEnds. Only architectural or incompatibility failures qualify. Every DeadEnd MUST specify "retryConditions".
3. SUPERSEDES: If an extracted decision replaces an earlier known decision, include the superseded decision ID in "supersedes".
4. OUTPUT FORMAT: Output valid JSON only, matching the following structure:
{
  "decisions": [...],
  "rcas": [...],
  "deadEnds": [...],
  "tasks": [...]
}

TRANSCRIPT TURNS:
${formattedEvents}
`;
  }

  /**
   * Compiles session events and updates wiki and active context cache
   */
  public compileSession(sessionFilePath: string, bundle: ExtractedBundle): void {
    // 1. Save all decisions and handle supersedes (FR-07)
    for (const dec of bundle.decisions) {
      const parsed = DecisionSchema.safeParse(dec);
      if (parsed.success) {
        // If this decision supersedes earlier ones, update those earlier ones
        for (const supersededId of parsed.data.supersedes) {
          const oldDec = this.storage.wiki.listDecisions().find((d) => d.id === supersededId);
          if (oldDec) {
            oldDec.status = 'superseded';
            oldDec.supersededBy = parsed.data.id;
            oldDec.updatedAt = new Date().toISOString();
            this.storage.wiki.saveDecision(oldDec);
          }
        }
        this.storage.wiki.saveDecision(parsed.data);
      }
    }

    // 2. Save RCAs
    for (const rca of bundle.rcas) {
      const parsed = RCASchema.safeParse(rca);
      if (parsed.success) {
        this.storage.wiki.saveRCA(parsed.data);
      }
    }

    // 3. Save DeadEnds (Soft Guardrail check)
    for (const de of bundle.deadEnds) {
      const parsed = DeadEndSchema.safeParse(de);
      if (parsed.success) {
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

    // 5. Regenerate Pre-compiled Context Cache (FR-19, NFR-07)
    this.refreshActiveContextCache();
  }

  /**
   * Refreshes active context cache with strict token budget (NFR-07: <= 800 tokens)
   */
  public refreshActiveContextCache(): void {
    const allDecisions = this.storage.wiki.listDecisions();
    const allDeadEnds = this.storage.wiki.listDeadEnds();

    // Active, high/medium confidence, not superseded
    const activeDecisions = allDecisions
      .filter((d) => d.status === 'active' && d.confidence !== 'low' && !d.supersededBy)
      .slice(0, 10)
      .map((d) => ({
        id: d.id,
        title: d.title,
        choice: d.choice,
        affectsModules: d.affectsModules,
      }));

    // Recent dead ends to warn against
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

    // Calculate approximate token count (~4 characters per token)
    const rawLength =
      JSON.stringify(activeDecisions).length + JSON.stringify(recentDeadEnds).length;
    const estimatedTokens = Math.ceil(rawLength / 4);

    this.storage.cache.setActiveContext({
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeDecisions,
      recentDeadEnds,
      estimatedTokens,
    });
  }
}
