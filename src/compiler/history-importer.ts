import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { type StorageManager } from '../storage/index.js';
import { type RawSessionEvent } from '../types/schemas.js';

export interface ImportHistoryOptions {
  antigravityBrainDir?: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  cursorProjectsDir?: string;
  cursorWorkspaceStorageDir?: string;
  aliases?: string[];
}

export interface ImportHistoryResult {
  antigravitySessionsImported: number;
  claudeSessionsImported: number;
  codexSessionsImported: number;
  cursorSessionsImported: number;
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
   * Discovers and imports past agent conversations from ALL 4 supported platforms
   * (Antigravity, Claude Code, Codex CLI, Cursor) into .agentrunlog/raw/ with secret redaction (FR-01, NFR-01).
   */
  public async importProjectHistory(options: ImportHistoryOptions = {}): Promise<ImportHistoryResult> {
    const projectName = basename(this.projectRoot);
    const matchTerms = this.buildProjectMatchTerms(projectName, options.aliases);

    const antigravityDir =
      options.antigravityBrainDir || join(homedir(), '.gemini', 'antigravity', 'brain');
    const claudeDir = options.claudeProjectsDir || join(homedir(), '.claude', 'projects');
    const codexDir = options.codexSessionsDir || join(homedir(), '.codex', 'sessions');
    const cursorProjDir = options.cursorProjectsDir || join(homedir(), '.cursor', 'projects');
    const cursorWsDir = options.cursorWorkspaceStorageDir || this.resolveCursorWorkspaceStorageDir();

    let agCount = 0;
    let claudeCount = 0;
    let codexCount = 0;
    let cursorCount = 0;
    let totalEvents = 0;
    const importedFiles: string[] = [];

    // 1. Scan Google Antigravity transcripts
    if (existsSync(antigravityDir)) {
      for (const convId of readdirSync(antigravityDir)) {
        const transcriptPath = join(antigravityDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;

        const events = this.parseAntigravityTranscript(transcriptPath, convId, matchTerms);
        if (events.length > 0) {
          const sessionId = `import_antigravity_${convId.slice(0, 8)}`;
          const written = this.writeImportedSession(sessionId, events);
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
      for (const projDir of readdirSync(claudeDir)) {
        const fullProjDir = join(claudeDir, projDir);
        try {
          if (!statSync(fullProjDir).isDirectory()) continue;
          const files = readdirSync(fullProjDir).filter((f) => f.endsWith('.jsonl'));
          for (const file of files) {
            const fullPath = join(fullProjDir, file);
            const events = this.parseClaudeTranscript(fullPath, file.replace('.jsonl', ''), matchTerms);
            if (events.length > 0) {
              const sessionId = `import_claude_${file.replace('.jsonl', '').slice(0, 8)}`;
              const written = this.writeImportedSession(sessionId, events);
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

    // 3. Scan OpenAI Codex CLI transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
    if (existsSync(codexDir)) {
      const codexFiles = this.collectFilesRecursive(codexDir, (name) => name.endsWith('.jsonl'));
      for (const filePath of codexFiles) {
        const rawName = basename(filePath, '.jsonl');
        const events = this.parseCodexTranscript(filePath, rawName, matchTerms);
        if (events.length > 0) {
          const shortId = rawName.replace(/[^a-zA-Z0-9]/g, '').slice(-10) || 'codex';
          const sessionId = `import_codex_${shortId}`;
          const written = this.writeImportedSession(sessionId, events);
          if (written > 0) {
            codexCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
          }
        }
      }
    }

    // 4A. Scan Cursor Agent Transcripts (~/.cursor/projects/<encoded>/agent-transcripts/*.jsonl)
    if (existsSync(cursorProjDir)) {
      const cursorFiles = this.collectFilesRecursive(cursorProjDir, (name) => name.endsWith('.jsonl'));
      for (const filePath of cursorFiles) {
        const rawName = basename(filePath, '.jsonl');
        const events = this.parseCursorJsonlTranscript(filePath, rawName, matchTerms);
        if (events.length > 0) {
          const shortId = rawName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'cursor';
          const sessionId = `import_cursor_${shortId}`;
          const written = this.writeImportedSession(sessionId, events);
          if (written > 0) {
            cursorCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
          }
        }
      }
    }

    // 4B. Scan Cursor Workspace Storage SQLite (state.vscdb)
    if (cursorWsDir && existsSync(cursorWsDir)) {
      const wsSessions = await this.parseCursorWorkspaceStorage(cursorWsDir, matchTerms);
      for (const { id, events } of wsSessions) {
        const sessionId = `import_cursor_ws_${id.slice(0, 8)}`;
        const written = this.writeImportedSession(sessionId, events);
        if (written > 0) {
          cursorCount++;
          totalEvents += written;
          importedFiles.push(`session-${sessionId}.jsonl`);
        }
      }
    }

    return {
      antigravitySessionsImported: agCount,
      claudeSessionsImported: claudeCount,
      codexSessionsImported: codexCount,
      cursorSessionsImported: cursorCount,
      totalEventsImported: totalEvents,
      importedFiles,
    };
  }

  private writeImportedSession(sessionId: string, events: RawSessionEvent[]): number {
    const targetRaw = join(this.storage.paths.raw, `session-${sessionId}.jsonl`);
    if (existsSync(targetRaw)) {
      try {
        unlinkSync(targetRaw);
      } catch {}
    }

    let written = 0;
    for (const ev of events) {
      ev.sessionId = sessionId;
      if (this.storage.logger.logEvent(ev)) {
        written++;
      }
    }
    return written;
  }

  private collectFilesRecursive(dir: string, filterFn: (name: string) => boolean): string[] {
    const results: string[] = [];
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) {
            results.push(...this.collectFilesRecursive(full, filterFn));
          } else if (st.isFile() && filterFn(entry)) {
            results.push(full);
          }
        } catch {}
      }
    } catch {}
    return results;
  }

  private resolveCursorWorkspaceStorageDir(): string {
    const home = homedir();
    if (process.platform === 'darwin') {
      return join(home, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    }
    if (process.platform === 'win32') {
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'workspaceStorage');
    }
    return join(home, '.config', 'Cursor', 'User', 'workspaceStorage');
  }

  private buildProjectMatchTerms(projectName: string, extraAliases?: string[]): string[] {
    const terms = new Set<string>();
    terms.add(this.projectRoot.toLowerCase());
    if (projectName.length >= 3) {
      terms.add(projectName.toLowerCase());
    }

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

      if (!matchTerms.some((term) => lowerRaw.includes(term))) return [];
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

      if (!matchTerms.some((term) => lowerRaw.includes(term))) return [];

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

  /**
   * Parses OpenAI Codex CLI rollout JSONL logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
   */
  private parseCodexTranscript(
    filePath: string,
    sessionId: string,
    matchTerms: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const lowerRaw = raw.toLowerCase();

      if (!matchTerms.some((term) => lowerRaw.includes(term))) return [];

      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const events: RawSessionEvent[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const timestamp = entry.timestamp || new Date().toISOString();
          const payloadType = entry.payload?.type || entry.type;

          if (payloadType === 'user_message' || (entry.type === 'response_item' && entry.payload?.role === 'user')) {
            const msg = entry.payload?.message || entry.payload?.content || '';
            const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
            if (text.length > 0) {
              events.push({
                sessionId,
                platform: 'codex',
                eventType: 'prompt_submit',
                timestamp,
                payload: { text: text.slice(0, 1500) },
              });
            }
          } else if (
            payloadType === 'agent_message' ||
            (entry.type === 'response_item' && entry.payload?.role === 'assistant')
          ) {
            const msg = entry.payload?.message || entry.payload?.content || '';
            const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
            if (text.length > 20) {
              events.push({
                sessionId,
                platform: 'codex',
                eventType: 'agent_response',
                timestamp,
                payload: { text: text.slice(0, 1200) },
              });
            }
          } else if (payloadType === 'local_shell_call_output' || entry.payload?.exit_code > 0) {
            const exitCode = Number(entry.payload?.exit_code ?? entry.payload?.metadata?.exit_code ?? 0);
            if (exitCode !== 0) {
              events.push({
                sessionId,
                platform: 'codex',
                eventType: 'post_tool_use',
                timestamp,
                payload: {
                  command: String(entry.payload?.command || 'codex_shell'),
                  exitCode,
                  error: String(entry.payload?.output || entry.payload?.error || '').slice(0, 600),
                },
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

  /**
   * Parses Cursor agent JSONL transcripts (~/.cursor/projects/<path>/agent-transcripts/*.jsonl)
   */
  private parseCursorJsonlTranscript(
    filePath: string,
    sessionId: string,
    matchTerms: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const lowerRaw = raw.toLowerCase();

      if (!matchTerms.some((term) => lowerRaw.includes(term)) && !filePath.toLowerCase().includes(basename(this.projectRoot).toLowerCase())) {
        return [];
      }

      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const events: RawSessionEvent[] = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const timestamp = entry.timestamp || new Date().toISOString();
          const role = entry.role || entry.type;

          if (role === 'user' || role === 'human') {
            const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || entry.text || '');
            if (text.length > 0) {
              events.push({
                sessionId,
                platform: 'cursor',
                eventType: 'prompt_submit',
                timestamp,
                payload: { text: text.slice(0, 1500) },
              });
            }
          } else if (role === 'assistant' || role === 'ai') {
            const text = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content || entry.text || '');
            if (text.length > 20) {
              events.push({
                sessionId,
                platform: 'cursor',
                eventType: 'agent_response',
                timestamp,
                payload: { text: text.slice(0, 1200) },
              });
            }
          } else if (entry.exitCode && entry.exitCode !== 0) {
            events.push({
              sessionId,
              platform: 'cursor',
              eventType: 'post_tool_use',
              timestamp,
              payload: {
                command: String(entry.command || 'cursor_shell'),
                exitCode: Number(entry.exitCode),
                error: String(entry.error || entry.output || '').slice(0, 600),
              },
            });
          }
        } catch {}
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Parses Cursor workspaceStorage SQLite state.vscdb (if Node built-in node:sqlite is available)
   */
  private async parseCursorWorkspaceStorage(
    wsStorageDir: string,
    matchTerms: string[]
  ): Promise<Array<{ id: string; events: RawSessionEvent[] }>> {
    const results: Array<{ id: string; events: RawSessionEvent[] }> = [];

    let DatabaseSync: any;
    try {
      const sqliteMod = await import('node:sqlite' as string);
      DatabaseSync = sqliteMod.DatabaseSync;
    } catch {
      // Built-in node:sqlite requires Node >= 22.5; gracefully skip on older Node
      return results;
    }

    try {
      for (const wsId of readdirSync(wsStorageDir)) {
        const wsFolder = join(wsStorageDir, wsId);
        const wsJsonPath = join(wsFolder, 'workspace.json');
        const dbPath = join(wsFolder, 'state.vscdb');
        if (!existsSync(wsJsonPath) || !existsSync(dbPath)) continue;

        try {
          const wsJsonRaw = readFileSync(wsJsonPath, 'utf8').toLowerCase();
          if (!matchTerms.some((t) => wsJsonRaw.includes(t))) continue;

          const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
          const rows = db
            .prepare("SELECT key, value FROM ItemTable WHERE key LIKE '%chat%' OR key LIKE '%composer%'")
            .all() as Array<{ key: string; value: string }>;
          db.close();

          const events: RawSessionEvent[] = [];
          for (const row of rows) {
            try {
              const data = JSON.parse(row.value);
              const tabs = data?.tabs || data?.allComposers || [];
              if (Array.isArray(tabs)) {
                for (const item of tabs) {
                  const bubbles = item?.bubbles || item?.conversation || [];
                  if (Array.isArray(bubbles)) {
                    for (const b of bubbles) {
                      const text = String(b.text || b.rawText || '').trim();
                      if (!text) continue;
                      events.push({
                        sessionId: wsId,
                        platform: 'cursor',
                        eventType: b.type === 'user' || b.type === 1 ? 'prompt_submit' : 'agent_response',
                        timestamp: b.timestamp || new Date().toISOString(),
                        payload: { text: text.slice(0, 1500) },
                      });
                    }
                  }
                }
              }
            } catch {}
          }

          if (events.length > 0) {
            results.push({ id: wsId, events });
          }
        } catch {}
      }
    } catch {}

    return results;
  }
}
