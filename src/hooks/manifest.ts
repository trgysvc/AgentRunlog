import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claude Code and Codex CLI both require hook entries grouped as
 *   "Event": [ { "hooks": [ { "type": "command", "command": "..." } ] } ]
 * A flat `{ type, command }` entry at the event level is not recognised.
 */
export type HookGroup = { matcher?: string; hooks: Array<{ type: 'command'; command: string }> };

export function nestedHookGroup(command: string): HookGroup[] {
  return [{ hooks: [{ type: 'command', command }] }];
}

function findPackageRoot(startDir: string): string {
  let current = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir, '../..');
}

/**
 * Absolute `node <entry>` command so hooks never depend on `runlog` being on PATH.
 * Prefers the dependency-free bundle/hook.mjs (NFR-05 latency); it accepts the same
 * `hook <platform> <event>` arguments as the full CLI, which is the fallback.
 */
export function defaultCliCommand(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(here);
  const light = resolve(root, 'bundle/hook.mjs');
  const entry = existsSync(light) ? light : resolve(root, 'dist/cli/index.js');
  return `"${process.execPath}" "${entry}"`;
}

/** MCP server entry (node + full CLI bundle) for project-level `.mcp.json`. */
export function defaultMcpEntry(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(here);
  const full = resolve(root, 'bundle/agentrunlog.mjs');
  const entry = existsSync(full) ? full : resolve(root, 'dist/cli/index.js');
  return { command: process.execPath, args: [entry, 'mcp'] };
}

export function isAgentRunlogEntry(entry: unknown): boolean {
  const s = JSON.stringify(entry);
  return s.includes('agentrunlog') || s.includes('runlog hook') || / hook (claude|codex|cursor|antigravity) /.test(s);
}

/**
 * Atomic JSON write: temp file + rename, so a crash never leaves a half-written user config.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Reads a JSON config. Missing file -> {}. Corrupt file -> throws, so callers stop instead of
 * overwriting the user's settings with an empty object.
 */
export function readJsonStrict(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Refusing to modify ${path}: it is not valid JSON (${(err as Error).message}). Fix or remove it and retry.`);
  }
}

/**
 * Merges AgentRunlog hook commands into a settings-style file idempotently,
 * keeping every non-AgentRunlog hook the user already has.
 */
export function mergeNestedHooks(path: string, commandsByEvent: Record<string, string>): void {
  const data = readJsonStrict(path);
  data.hooks = data.hooks || {};
  for (const [event, command] of Object.entries(commandsByEvent)) {
    const existing = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    data.hooks[event] = [...existing.filter((e: unknown) => !isAgentRunlogEntry(e)), ...nestedHookGroup(command)];
  }
  writeJsonAtomic(path, data);
}

export type HookPlatform = 'claude' | 'antigravity' | 'cursor' | 'codex';

/** Where the user-level (global) AgentRunlog hooks of a platform live. */
export function globalHookFiles(platform: HookPlatform, home: string = homedir()): string[] {
  switch (platform) {
    case 'claude':
      return [join(home, '.claude', 'settings.json')];
    case 'cursor':
      return [join(home, '.cursor', 'hooks.json')];
    case 'codex':
      return [join(home, '.codex', 'hooks.json')];
    case 'antigravity':
      return [join(home, '.gemini', 'config', 'plugins', 'agentrunlog', 'hooks.json'), join(home, '.gemini', 'config', 'hooks.json')];
  }
}

/**
 * True when the user-level install already registers our hooks. The agents merge user-level and
 * project-level hooks and run both, so registering again in the project would fire every event twice.
 */
export function globalHooksRegistered(platform: HookPlatform, home: string = homedir()): boolean {
  return globalHookFiles(platform, home).some((f) => {
    try {
      return existsSync(f) && isAgentRunlogEntry(JSON.parse(readFileSync(f, 'utf8')));
    } catch {
      return false;
    }
  });
}

/** Removes only AgentRunlog's own hook entries from a project hooks file (the user's other hooks stay). */
export function removeOurHooks(path: string, platform: HookPlatform): boolean {
  if (!existsSync(path)) return false;
  const data = readJsonStrict(path);
  let changed = false;
  if (platform === 'antigravity') {
    for (const k of Object.keys(data)) {
      if (k === 'agentrunlog' || (typeof data[k] === 'object' && isAgentRunlogEntry(data[k]))) {
        delete data[k];
        changed = true;
      }
    }
  } else if (data.hooks && typeof data.hooks === 'object') {
    for (const [event, entries] of Object.entries<any>(data.hooks)) {
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((e) => !isAgentRunlogEntry(e));
      if (kept.length !== entries.length) {
        changed = true;
        if (kept.length) data.hooks[event] = kept;
        else delete data.hooks[event];
      }
    }
  }
  if (changed) writeJsonAtomic(path, data);
  return changed;
}
