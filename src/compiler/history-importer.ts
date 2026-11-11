import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { type StorageManager } from '../storage/index.js';
import { type RawSessionEvent } from '../types/schemas.js';

export interface ImportHistoryOptions {
  antigravityBrainDir?: string;
  claudeProjectsDir?: string;
  aliases?: string[];
}

export interface ImportHistoryResult {
  antigravitySessionsImported: number;
  claudeSessionsImported: number;
  totalEventsImported: number;
  importedFiles: string[];
}

export class HistoryImporter {
  private storage: StorageManager;
  private projectRoot: string;

  constructor(storage: StorageManager, projectRoot: string = process.cwd()) {
    this.storage = storage;
    this.projectRoot = projectRoot;
  }

  /**
   * Discovers and imports past agent conversations (Antigravity, Claude Code)
   * matching the target project into .agentrunlog/raw/ with secret redaction (FR-01, NFR-01).
   */
  public importProjectHistory(options: ImportHistoryOptions = {}): ImportHistoryResult {
    const projectName = basename(this.projectRoot);
    const matchTerms = this.buildProjectMatchTerms(projectName, options.aliases);

    const antigravityDir =
      options.antigravityBrainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
    const claudeDir = options.claudeProjectsDir || join(homedir(), '.claude', 'projects');

    let agCount = 0;
    let claudeCount = 0;
    let totalEvents = 0;
    const importedFiles: string[] = [];

    // 1. Scan Antigravity transcripts
    if (existsSync(antigravityDir)) {
      const convDirs = readdirSync(antigravityDir);
      for (const convId of convDirs) {
        const transcriptPath = join(antigravityDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;

        const events = this.parseAntigravityTranscript(transcriptPath, convId, matchTerms);
        if (events.length > 0) {
          const sessionId = `import_antigravity_${convId.slice(0, 8)}`;
          const targetRaw = join(this.storage.paths.raw, `session-${sessionId}.jsonl`);
          if (existsSync(targetRaw)) unlinkSync(targetRaw);

          let written = 0;
          for (const ev of events) {
            ev.sessionId = sessionId;
            if (this.storage.logger.logEvent(ev)) {
              written++;
            }
          }
          if (written > 0) {
            agCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
          }
        }
      }
    }

    // 2. Scan Claude Code transcripts
    if (existsSync(claudeDir)) {
      const projDirs = readdirSync(claudeDir);
      for (const projDir of projDirs) {
        const fullProjDir = join(claudeDir, projDir);
        try {
          const files = readdirSync(fullProjDir).filter((f) => f.endsWith('.jsonl'));
          for (const file of files) {
            const fullPath = join(fullProjDir, file);
            const events = this.parseClaudeTranscript(fullPath, file.replace('.jsonl', ''), matchTerms);
            if (events.length > 0) {
              const sessionId = `import_claude_${file.replace('.jsonl', '').slice(0, 8)}`;
              const targetRaw = join(this.storage.paths.raw, `session-${sessionId}.jsonl`);
              if (existsSync(targetRaw)) unlinkSync(targetRaw);

              let written = 0;
              for (const ev of events) {
                ev.sessionId = sessionId;
                if (this.storage.logger.logEvent(ev)) {
                  written++;
                }
              }
              if (written > 0) {
                claudeCount++;
                totalEvents += written;
                importedFiles.push(`session-${sessionId}.jsonl`);
              }
            }
          }
        } catch {}
      }
    }

    return {
      antigravitySessionsImported: agCount,
      claudeSessionsImported: claudeCount,
      totalEventsImported: totalEvents,
      importedFiles,
    };
  }

  private buildProjectMatchTerms(projectName: string, extraAliases?: string[]): string[] {
    const terms = new Set<string>();
    terms.add(this.projectRoot.toLowerCase());
    if (projectName.length >= 3) {
      terms.add(projectName.toLowerCase());
    }

    // Also read package.json name if available
    const pkgPath = join(this.projectRoot, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name && typeof pkg.name === 'string' && pkg.name.length >= 3) {
          terms.add(pkg.name.toLowerCase());
        }
      } catch {}
    }

    if (extraAliases) {
      for (const a of extraAliases) {
        if (a.length >= 3) terms.add(a.toLowerCase());
      }
    }

    return Array.from(terms);
  }

  private parseAntigravityTranscript(
    filePath: string,
    convId: string,
    matchTerms: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const lowerRaw = raw.toLowerCase();

      // Must mention project path or project name
      const matchesProject = matchTerms.some((term) => lowerRaw.includes(term));
      if (!matchesProject) return [];

      // Exclude internal compiler/architect subagent logs
      if (lowerRaw.includes('agentrunlog_internal') || lowerRaw.includes('sen projenin baş mimarı')) {
        return [];
      }

      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const events: RawSessionEvent[] = [];

      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          const timestamp = step.created_at || new Date().toISOString();

          if (step.type === 'USER_INPUT' && step.content) {
            const reqMatch = String(step.content).match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const cleanPrompt = (reqMatch ? reqMatch[1] : String(step.content)).trim();
            if (cleanPrompt.length > 0) {
              events.push({
                sessionId: convId,
                platform: 'antigravity',
                eventType: 'prompt_submit',
                timestamp,
                payload: { text: cleanPrompt.slice(0, 1500) },
              });
            }
          } else if (step.type === 'GENERIC' && step.content) {
            const content = String(step.content);
            const exitMatch = content.match(/Command exited with code ([1-9]\d*)/);
            if (exitMatch) {
              events.push({
                sessionId: convId,
                platform: 'antigravity',
                eventType: 'post_tool_use',
                timestamp,
                payload: {
                  command: 'terminal_command',
                  exitCode: Number(exitMatch[1]),
                  error: content.slice(0, 600),
                },
              });
            }
          } else if (step.type === 'PLANNER_RESPONSE' && step.content) {
            const responseText = String(step.content).trim();
            if (responseText.length > 20) {
              events.push({
                sessionId: convId,
                platform: 'antigravity',
                eventType: 'agent_response',
                timestamp,
                payload: { text: responseText.slice(0, 1200) },
              });
            }
          }
        } catch {}
      }

      return events;
    } catch {
      return [];
    }
  }

  private parseClaudeTranscript(
    filePath: string,
    sessionId: string,
    matchTerms: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const lowerRaw = raw.toLowerCase();

      const matchesProject = matchTerms.some((term) => lowerRaw.includes(term));
      if (!matchesProject) return [];

      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const events: RawSessionEvent[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const timestamp = entry.timestamp || new Date().toISOString();

          if (entry.type === 'user' && entry.message?.content) {
            const content =
              typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content);
            if (content.length > 0) {
              events.push({
                sessionId,
                platform: 'claude_code',
                eventType: 'prompt_submit',
                timestamp,
                payload: { text: content.slice(0, 1500) },
              });
            }
          } else if (entry.type === 'assistant' && entry.message?.content) {
            const content =
              typeof entry.message.content === 'string'
                ? entry.message.content
                : JSON.stringify(entry.message.content);
            if (content.length > 20) {
              events.push({
                sessionId,
                platform: 'claude_code',
                eventType: 'agent_response',
                timestamp,
                payload: { text: content.slice(0, 1200) },
              });
            }
          }
        } catch {}
      }

      return events;
    } catch {
      return [];
    }
  }
}
