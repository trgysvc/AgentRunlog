import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { formatPushText } from './push-format.js';
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
    const tmp = `${this.cacheFilePath}.${process.pid}.tmp`;
    writeFileSync(tmp, raw, 'utf8');
    renameSync(tmp, this.cacheFilePath);
  }

  /**
   * Formats active context as markdown text for hook prompt injection (NFR-07 hard ceiling).
   */
  public formatPushInjection(cache: ActiveContextCache | null): string | null {
    return formatPushText(cache);
  }
}
