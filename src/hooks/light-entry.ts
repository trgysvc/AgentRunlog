#!/usr/bin/env node
/**
 * Standalone hook entry (bundled to bundle/hook.mjs). Usage: node hook.mjs [hook] <platform> <event> [sessionId]
 * Deliberately avoids zod / gray-matter / MCP SDK to honour the NFR-05 latency budget.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidProjectDirectory } from '../compiler/project-dir.js';
import { runLightHook } from './light.js';

const STDIN_CAP_MS = 1000;
const STDIN_MAX_BYTES = 8 * 1024 * 1024;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, STDIN_CAP_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      data += c;
      if (data.length > STDIN_MAX_BYTES) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'hook') argv.shift();
  const [platform = 'claude', event = 'session-start', sessionId] = argv;

  const raw = await readStdin();
  let payload: Record<string, unknown> = {};
  let payloadParsed = false;
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
        payloadParsed = true;
      }
    } catch {
      // unparsable payload: do not invent a session for it
    }
  }

  const roots = payload.workspace_roots;
  const projectRoot =
    (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) ||
    (typeof payload.cwd === 'string' && payload.cwd) ||
    process.cwd();
  if (!isValidProjectDirectory(projectRoot)) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = join(here, 'agentrunlog.mjs');
  const cliPath = existsSync(sibling) ? sibling : undefined;

  const push = runLightHook({
    platform,
    event,
    sessionId,
    payload,
    payloadParsed,
    storageRoot: join(projectRoot, '.agentrunlog'),
    cliPath,
  });
  if (push) {
    // Cursor's sessionStart hook injects context through a JSON field instead of plain stdout.
    const isCursor = platform.toLowerCase().includes('cursor');
    process.stdout.write((isCursor ? JSON.stringify({ additional_context: push }) : push) + '\n');
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
