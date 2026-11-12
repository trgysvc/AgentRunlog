#!/usr/bin/env node
/**
 * Standalone hook entry (bundled to bundle/hook.mjs). Usage: node hook.mjs [hook] <platform> <event> [sessionId]
 * Deliberately avoids zod / gray-matter / MCP SDK to honour the NFR-05 latency budget.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidProjectDirectory } from '../compiler/project-dir.js';
import { formatHookOutput, runLightHook } from './light.js';

// No size cap: a cut-off payload is unparsable JSON and the event would be lost. Instead we wait
// for the stream to end, and only give up when the sender goes silent (idle) for a while.
const STDIN_FIRST_BYTE_MS = 1000;
const STDIN_IDLE_MS = 5000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks: string[] = [];
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(chunks.join(''));
    };
    timer = setTimeout(finish, STDIN_FIRST_BYTE_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      chunks.push(c);
      clearTimeout(timer);
      timer = setTimeout(finish, STDIN_IDLE_MS);
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
      // unparsable payload: do not invent a session for it, but never lose it silently either
      try {
        const root = (typeof process.cwd === 'function' && process.cwd()) || '';
        if (root && isValidProjectDirectory(root)) {
          const dir = join(root, '.agentrunlog', 'cache');
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, 'hook-errors.log'), `${new Date().toISOString()} unparsable payload platform=${platform} event=${argv[1] ?? ''} bytes=${raw.length}\n`);
        }
      } catch {}
    }
  }

  const roots = payload.workspace_roots ?? payload.workspacePaths;
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
  const out = formatHookOutput(platform, event, push);
  if (out) process.stdout.write(out + '\n');
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
