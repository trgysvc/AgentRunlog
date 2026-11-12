import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'pubspec.yaml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Makefile',
  'Dockerfile',
];

/**
 * Checks whether a directory is a genuine software project workspace
 * (prevents accidentally creating .agentrunlog in $HOME, /, or plugin directories).
 * Dependency-free on purpose: it is used by the lightweight hook entry.
 */
export function isValidProjectDirectory(dir: string): boolean {
  const abs = resolve(dir);
  const home = resolve(homedir());

  if (abs === '/' || abs === home) return false;
  if (abs.includes('/.gemini/') || abs.includes('/.claude/') || abs.includes('/.cursor/') || abs.includes('/.codex/')) {
    return false;
  }

  return PROJECT_MARKERS.some((marker) => existsSync(join(abs, marker)));
}
