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
import { LLMCompilerClient, type LLMClientConfig } from './llm-client.js';

export interface ExtractedBundle {
  decisions: Decision[];
  rcas: RCA[];
  deadEnds: DeadEnd[];
  tasks: Task[];
}

export interface CompilerOptions extends LLMClientConfig {}

export class TranscriptExtractor {
  private storage: StorageManager;
  private llmClient: LLMCompilerClient;

  constructor(storage: StorageManager, options: CompilerOptions = {}) {
    this.storage = storage;
    this.llmClient = new LLMCompilerClient(options);
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
   * Extracts typed records using the LLM client (or heuristic fallback) and compiles them.
   */
  public async extractAndCompile(sessionFilePath: string): Promise<ExtractedBundle> {
    const events = this.readSessionEvents(sessionFilePath);
    if (events.length === 0) {
      return { decisions: [], rcas: [], deadEnds: [], tasks: [] };
    }

    const prompt = this.buildCompilerPrompt(events);
    const bundle = await this.llmClient.extract(prompt, events);
    this.compileSession(sessionFilePath, bundle);
    return bundle;
  }

  /**
   * Compiles session events and updates wiki, module pages, index.md and active context cache
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

    // 5. Generate wiki/index.md and wiki/modules/*.md (FR-08)
    this.storage.wiki.generateIndexAndModules();

    // 6. Regenerate Pre-compiled Context Cache (FR-19, NFR-07)
    this.refreshActiveContextCache();
  }

  /**
   * Refreshes active context cache with strict token budget (NFR-07: <= 800 tokens)
   */
  public refreshActiveContextCache(): void {
    const allDecisions = this.storage.wiki.listDecisions();
    const allDeadEnds = this.storage.wiki.listDeadEnds();
    const allRCAs = this.storage.wiki.listRCAs();

    const maxChars = (this.storage.config.maxPushTokens || 800) * 4;
    let currentChars = 0;

    // Prioritize high-signal records within strict NFR-07 token budget
    const activeDecisions: Array<{ id: string; title: string; choice: string; affectsModules: string[] }> = [];
    const recentDeadEnds: Array<{
      id: string;
      title: string;
      approach: string;
      whyFailed: string;
      retryConditions: string;
      affectsModules: string[];
    }> = [];
    const recentRCAs: Array<{ id: string; title: string; incident: string; resolution: string }> = [];

    // 1. Add known dead ends first (prevent repeated failures)
    for (const de of allDeadEnds.filter((d) => d.confidence !== 'low').slice(0, 5)) {
      const item = {
        id: de.id,
        title: de.title.slice(0, 80),
        approach: de.approach.slice(0, 120),
        whyFailed: de.whyFailed.slice(0, 140),
        retryConditions: de.retryConditions.slice(0, 140),
        affectsModules: de.affectsModules,
      };
      const cost = JSON.stringify(item).length;
      if (currentChars + cost <= maxChars) {
        recentDeadEnds.push(item);
        currentChars += cost;
      }
    }

    // 2. Add active non-superseded decisions
    for (const d of allDecisions.filter((x) => x.status === 'active' && x.confidence !== 'low' && !x.supersededBy)) {
      const item = {
        id: d.id,
        title: d.title.slice(0, 80),
        choice: d.choice.slice(0, 180),
        affectsModules: d.affectsModules,
      };
      const cost = JSON.stringify(item).length;
      if (currentChars + cost <= maxChars) {
        activeDecisions.push(item);
        currentChars += cost;
      }
    }

    // 3. Add recent RCAs if budget remains
    for (const r of allRCAs.filter((x) => x.confidence !== 'low').slice(-3).reverse()) {
      const item = {
        id: r.id,
        title: r.title.slice(0, 80),
        incident: r.incident.slice(0, 120),
        resolution: r.resolution.slice(0, 120),
      };
      const cost = JSON.stringify(item).length;
      if (currentChars + cost <= maxChars) {
        recentRCAs.push(item);
        currentChars += cost;
      }
    }

    const estimatedTokens = Math.ceil(currentChars / 4);

    this.storage.cache.setActiveContext({
      version: 1,
      lastUpdated: new Date().toISOString(),
      activeDecisions,
      recentDeadEnds,
      recentRCAs,
      estimatedTokens,
    });
  }
}
