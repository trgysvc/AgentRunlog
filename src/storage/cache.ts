import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type ActiveContextCache, ActiveContextCacheSchema } from '../types/schemas.js';
import { type StoragePaths } from './paths.js';

export class ContextCacheManager {
  private cacheFilePath: string;

  constructor(paths: StoragePaths) {
    this.cacheFilePath = paths.activeContextCache;
  }

  /**
   * Reads active context cache synchronously. Guaranteed < 5ms read.
   */
  public getActiveContext(): ActiveContextCache | null {
    try {
      if (!existsSync(this.cacheFilePath)) {
        return null;
      }
      const raw = readFileSync(this.cacheFilePath, 'utf8');
      const data = JSON.parse(raw);
      const parsed = ActiveContextCacheSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Saves updated active context cache atomically.
   */
  public setActiveContext(cache: ActiveContextCache): void {
    const raw = JSON.stringify(cache, null, 2);
    writeFileSync(this.cacheFilePath, raw, 'utf8');
  }

  /**
   * Formats active context as markdown text for hook prompt injection (< 800 tokens).
   */
  public formatPushInjection(cache: ActiveContextCache | null): string | null {
    if (!cache) return null;
    if (cache.activeDecisions.length === 0 && cache.recentDeadEnds.length === 0) {
      return null;
    }

    const sections: string[] = ['<!-- AGENTRUNLOG_CONTEXT_START -->'];

    if (cache.activeDecisions.length > 0) {
      sections.push('### 🧠 AgentRunlog Active Decisions:');
      for (const dec of cache.activeDecisions) {
        sections.push(`- **[${dec.id}] ${dec.title}**: ${dec.choice}`);
      }
    }

    if (cache.recentDeadEnds.length > 0) {
      sections.push('### ⚠️ Known Dead Ends (Do Not Repeat):');
      for (const de of cache.recentDeadEnds) {
        sections.push(
          `- **[${de.id}] ${de.title}**: Failed because "${de.whyFailed}". Retry condition: ${de.retryConditions}`
        );
      }
    }

    sections.push('<!-- AGENTRUNLOG_CONTEXT_END -->');
    return sections.join('\n');
  }
}
