import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { type RawSessionEvent, RawSessionEventSchema } from '../types/schemas.js';
import { defaultSanitizer, Sanitizer } from '../sanitizer/index.js';
import { type StoragePaths } from './paths.js';

export class SessionLogger {
  private rawDir: string;
  private sanitizer: Sanitizer;

  constructor(paths: StoragePaths, sanitizer: Sanitizer = defaultSanitizer) {
    this.rawDir = paths.raw;
    this.sanitizer = sanitizer;
  }

  /**
   * Log an event to raw JSONL stream atomically with secret redaction.
   * Enforces NFR-09 (Recursion protection) and NFR-01 (Sanitization).
   */
  public logEvent(event: RawSessionEvent): boolean {
    // 1. NFR-09: Double-layer recursion protection
    if (process.env.AGENTRUNLOG_INTERNAL === '1' || process.env.AGENTRUNLOG_SKIP === '1') {
      return false;
    }
    if (event.caller === 'agentrunlog-compiler') {
      return false;
    }

    // 2. Validate event schema
    const parsed = RawSessionEventSchema.safeParse(event);
    if (!parsed.success) {
      console.error('Invalid RawSessionEvent:', parsed.error);
      return false;
    }

    // 3. NFR-01: Redact secrets before writing to disk
    const sanitizedEvent: RawSessionEvent = {
      ...parsed.data,
      payload: this.sanitizer.redactObject(parsed.data.payload) as Record<string, unknown>,
    };

    // 4. Atomic append to session file
    const safeSessionId = sanitizedEvent.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = join(this.rawDir, `session-${safeSessionId}.jsonl`);

    try {
      const line = JSON.stringify(sanitizedEvent) + '\n';
      // appendFileSync ensures atomic append for POSIX buffers under PIPE_BUF (4096 bytes)
      appendFileSync(filePath, line, { encoding: 'utf8' });
      return true;
    } catch (err) {
      console.error('Failed to append raw session event:', err);
      return false;
    }
  }
}
