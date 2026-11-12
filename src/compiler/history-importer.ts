import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  force?: boolean;
}

export interface ImportHistoryResult {
  antigravitySessionsImported: number;
  claudeSessionsImported: number;
  codexSessionsImported: number;
  cursorSessionsImported: number;
  skippedUnchanged: number;
  totalEventsImported: number;
  importedFiles: string[];
}

interface ImportFileState {
  mtimeMs: number;
  size: number;
  importedSessionId: string;
}

interface ImportStateCache {
  version: number;
  files: Record<string, ImportFileState>;
}

const GENERIC_FOLDER_STOPWORDS = new Set([
  'src', 'app', 'core', 'backend', 'frontend', 'api', 'server', 'client',
  'lib', 'docs', 'web', 'mobile', 'test', 'tests', 'repo', 'code', 'project', 'home'
]);

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class HistoryImporter {
  private storage: StorageManager;
  private projectRoot: string;
  private stateFilePath: string;

  constructor(storage: StorageManager, projectRoot: string = process.cwd()) {
    this.storage = storage;
    this.projectRoot = projectRoot;
    this.stateFilePath = join(storage.paths.cache, 'import_state.json');
  }

  private loadImportState(): ImportStateCache {
    try {
      if (existsSync(this.stateFilePath)) {
        const parsed = JSON.parse(readFileSync(this.stateFilePath, 'utf8'));
        if (parsed && typeof parsed.files === 'object') {
          return parsed as ImportStateCache;
        }
      }
    } catch {}
    return { version: 1, files: {} };
  }

  private saveImportState(state: ImportStateCache): void {
    try {
      writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }

  /**
   * 3-Tier Deterministic Project Match (Argon Directive):
   * Tier 1: Exact projectRoot absolute path OR path segment (/${projectName}/ or \\${projectName}\\)
   * Tier 2: Non-generic alias/package name with word boundary appearing >= 3 times (avoids casual mentions)
   */
  private matchesProjectDeterministic(rawContent: string, matchTerms: string[], aliases: string[]): boolean {
    const lowerRaw = rawContent.toLowerCase();
    const absRootLower = this.projectRoot.toLowerCase();

    // Tier 1A: Exact absolute project path anywhere in tool calls/prompts
    if (lowerRaw.includes(absRootLower)) {
      return true;
    }

    // Tier 1B: Project folder path boundary (/ProjectName/ or \ProjectName\)
    const folderName = basename(this.projectRoot).toLowerCase();
    if (folderName.length >= 3 && !GENERIC_FOLDER_STOPWORDS.has(folderName)) {
      if (
        lowerRaw.includes(`/${folderName}/`) ||
        lowerRaw.includes(`\\${folderName}\\`) ||
        lowerRaw.includes(`/${folderName}"`) ||
        lowerRaw.includes(`/${folderName}'`)
      ) {
        return true;
      }
    }

    // Tier 2A: Automatic non-generic project/package name appearing >= 2 times with word boundaries
    const autoTerms = matchTerms.filter((t) => t.length >= 4 && !GENERIC_FOLDER_STOPWORDS.has(t));
    for (const term of autoTerms) {
      const regex = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi');
      const matches = rawContent.match(regex);
      if (matches && matches.length >= 2) {
        return true;
      }
    }

    // Tier 2B: Explicit user-supplied --alias with word boundaries
    const cleanAliases = aliases.filter((t) => t.length >= 3 && !GENERIC_FOLDER_STOPWORDS.has(t));
    for (const alias of cleanAliases) {
      const regex = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
      if (regex.test(rawContent)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Discovers and imports past agent conversations from ALL 4 supported platforms
   * with incremental mtime/size tracking (import_state.json) and secret redaction.
   */
  public async importProjectHistory(options: ImportHistoryOptions = {}): Promise<ImportHistoryResult> {
    const projectName = basename(this.projectRoot);
    const { matchTerms, aliases } = this.buildProjectMatchTerms(projectName, options.aliases);
    const state = options.force ? { version: 1, files: {} } : this.loadImportState();

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
    let skippedUnchanged = 0;
    let totalEvents = 0;
    const importedFiles: string[] = [];

    const checkNeedsImport = (filePath: string): { needsImport: boolean; mtimeMs: number; size: number } => {
      try {
        const st = statSync(filePath);
        const prev = state.files[filePath];
        if (!options.force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          return { needsImport: false, mtimeMs: st.mtimeMs, size: st.size };
        }
        return { needsImport: true, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return { needsImport: false, mtimeMs: 0, size: 0 };
      }
    };

    // 1. Scan Google Antigravity transcripts
    if (existsSync(antigravityDir)) {
      for (const convId of readdirSync(antigravityDir)) {
        const transcriptPath = join(antigravityDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath)) continue;

        const check = checkNeedsImport(transcriptPath);
        if (!check.needsImport) {
          skippedUnchanged++;
          continue;
        }

        const events = this.parseAntigravityTranscript(transcriptPath, convId, matchTerms, aliases);
        if (events.length > 0) {
          const sessionId = `import_antigravity_${convId.slice(0, 8)}`;
          const written = this.writeImportedSession(sessionId, events);
          if (written > 0) {
            agCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
            state.files[transcriptPath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: sessionId };
          }
        } else {
          // Record as checked so we don't re-read unrelated conversations unless they change
          state.files[transcriptPath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: '' };
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
            const check = checkNeedsImport(fullPath);
            if (!check.needsImport) {
              skippedUnchanged++;
              continue;
            }

            const events = this.parseClaudeTranscript(fullPath, file.replace('.jsonl', ''), matchTerms, aliases);
            if (events.length > 0) {
              const sessionId = `import_claude_${file.replace('.jsonl', '').slice(0, 8)}`;
              const written = this.writeImportedSession(sessionId, events);
              if (written > 0) {
                claudeCount++;
                totalEvents += written;
                importedFiles.push(`session-${sessionId}.jsonl`);
                state.files[fullPath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: sessionId };
              }
            } else {
              state.files[fullPath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: '' };
            }
          }
        } catch {}
      }
    }

    // 3. Scan OpenAI Codex CLI transcripts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
    if (existsSync(codexDir)) {
      const codexFiles = this.collectFilesRecursive(codexDir, (name) => name.endsWith('.jsonl'));
      for (const filePath of codexFiles) {
        const check = checkNeedsImport(filePath);
        if (!check.needsImport) {
          skippedUnchanged++;
          continue;
        }

        const rawName = basename(filePath, '.jsonl');
        const events = this.parseCodexTranscript(filePath, rawName, matchTerms, aliases);
        if (events.length > 0) {
          const shortId = rawName.replace(/[^a-zA-Z0-9]/g, '').slice(-10) || 'codex';
          const sessionId = `import_codex_${shortId}`;
          const written = this.writeImportedSession(sessionId, events);
          if (written > 0) {
            codexCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
            state.files[filePath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: sessionId };
          }
        } else {
          state.files[filePath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: '' };
        }
      }
    }

    // 4A. Scan Cursor Agent Transcripts
    if (existsSync(cursorProjDir)) {
      const cursorFiles = this.collectFilesRecursive(cursorProjDir, (name) => name.endsWith('.jsonl'));
      for (const filePath of cursorFiles) {
        const check = checkNeedsImport(filePath);
        if (!check.needsImport) {
          skippedUnchanged++;
          continue;
        }

        const rawName = basename(filePath, '.jsonl');
        const events = this.parseCursorJsonlTranscript(filePath, rawName, matchTerms, aliases);
        if (events.length > 0) {
          const shortId = rawName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'cursor';
          const sessionId = `import_cursor_${shortId}`;
          const written = this.writeImportedSession(sessionId, events);
          if (written > 0) {
            cursorCount++;
            totalEvents += written;
            importedFiles.push(`session-${sessionId}.jsonl`);
            state.files[filePath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: sessionId };
          }
        } else {
          state.files[filePath] = { mtimeMs: check.mtimeMs, size: check.size, importedSessionId: '' };
        }
      }
    }

    // 4B. Scan Cursor Workspace Storage SQLite (state.vscdb)
    if (cursorWsDir && existsSync(cursorWsDir)) {
      const wsSessions = await this.parseCursorWorkspaceStorage(cursorWsDir, matchTerms, aliases);
      for (const { id, dbPath, mtimeMs, size, events } of wsSessions) {
        const prev = state.files[dbPath];
        if (!options.force && prev && prev.mtimeMs === mtimeMs && prev.size === size) {
          skippedUnchanged++;
          continue;
        }
        const sessionId = `import_cursor_ws_${id.slice(0, 8)}`;
        const written = this.writeImportedSession(sessionId, events);
        if (written > 0) {
          cursorCount++;
          totalEvents += written;
          importedFiles.push(`session-${sessionId}.jsonl`);
          state.files[dbPath] = { mtimeMs, size, importedSessionId: sessionId };
        }
      }
    }

    this.saveImportState(state);

    return {
      antigravitySessionsImported: agCount,
      claudeSessionsImported: claudeCount,
      codexSessionsImported: codexCount,
      cursorSessionsImported: cursorCount,
      skippedUnchanged,
      totalEventsImported: totalEvents,
      importedFiles,
    };
  }

  private writeImportedSession(sessionId: string, events: RawSessionEvent[]): number {
    if (events.length === 0) return 0; // never wipe an earlier import for an empty parse
    const targetRaw = join(this.storage.paths.raw, `session-${sessionId}.jsonl`);
    if (existsSync(targetRaw)) {
      try {
        unlinkSync(targetRaw);
      } catch {}
    }

    let written = 0;
    for (const ev of events) {
      ev.sessionId = sessionId;
      if (this.storage.logger.logEvent(ev, { trustedImport: true })) {
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

  private buildProjectMatchTerms(
    projectName: string,
    extraAliases?: string[]
  ): { matchTerms: string[]; aliases: string[] } {
    const terms = new Set<string>();
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

    const aliases = (extraAliases || []).map((a) => a.toLowerCase()).filter((a) => a.length >= 3);
    return { matchTerms: Array.from(terms), aliases };
  }

  private parseAntigravityTranscript(
    filePath: string,
    convId: string,
    matchTerms: string[],
    aliases: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const lowerRaw = raw.toLowerCase();

      if (lowerRaw.includes('agentrunlog_internal') || lowerRaw.includes('sen projenin baş mimarı')) {
        return [];
      }
      if (!this.matchesProjectDeterministic(raw, matchTerms, aliases)) return [];

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
                payload: { text: cleanPrompt },
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
                  error: content,
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
                payload: { text: responseText },
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
    matchTerms: string[],
    aliases: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      if (!this.matchesProjectDeterministic(raw, matchTerms, aliases)) return [];

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
                payload: { text: content },
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
                payload: { text: content },
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

  private parseCodexTranscript(
    filePath: string,
    sessionId: string,
    matchTerms: string[],
    aliases: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      if (!this.matchesProjectDeterministic(raw, matchTerms, aliases)) return [];

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
                payload: { text: text },
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
                payload: { text: text },
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
                  error: String(entry.payload?.output || entry.payload?.error || ''),
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

  private parseCursorJsonlTranscript(
    filePath: string,
    sessionId: string,
    matchTerms: string[],
    aliases: string[]
  ): RawSessionEvent[] {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const folderInPath = filePath.toLowerCase().includes(basename(this.projectRoot).toLowerCase());
      if (!folderInPath && !this.matchesProjectDeterministic(raw, matchTerms, aliases)) {
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
                payload: { text: text },
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
                payload: { text: text },
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
                error: String(entry.error || entry.output || ''),
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

  private async parseCursorWorkspaceStorage(
    wsStorageDir: string,
    matchTerms: string[],
    aliases: string[]
  ): Promise<Array<{ id: string; dbPath: string; mtimeMs: number; size: number; events: RawSessionEvent[] }>> {
    const results: Array<{ id: string; dbPath: string; mtimeMs: number; size: number; events: RawSessionEvent[] }> = [];

    let DatabaseSync: any;
    try {
      const sqliteMod = await import('node:sqlite' as string);
      DatabaseSync = sqliteMod.DatabaseSync;
    } catch {
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
          const absLower = this.projectRoot.toLowerCase();
          const allTerms = [absLower, ...matchTerms, ...aliases].filter((t) => !GENERIC_FOLDER_STOPWORDS.has(t));
          if (!allTerms.some((t) => wsJsonRaw.includes(t))) continue;

          const st = statSync(dbPath);
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
                        payload: { text: text },
                      });
                    }
                  }
                }
              }
            } catch {}
          }

          if (events.length > 0) {
            results.push({ id: wsId, dbPath, mtimeMs: st.mtimeMs, size: st.size, events });
          }
        } catch {}
      }
    } catch {}

    return results;
  }
}
