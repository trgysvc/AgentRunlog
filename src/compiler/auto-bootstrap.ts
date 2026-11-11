import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { StorageManager } from '../storage/index.js';
import { CodebaseScanner } from './scanner.js';
import { HistoryImporter } from './history-importer.js';
import { TranscriptExtractor } from './extractor.js';

const PROJECT_MARKERS = [
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

/**
 * Automatically initializes .agentrunlog/, updates .gitignore, scans codebase + 4-platform history,
 * and marks bootstrap.done so it only runs once per project automatically.
 */
export async function ensureProjectBootstrapped(projectRoot: string): Promise<{
  bootstrappedNow: boolean;
  storage: StorageManager;
}> {
  const storage = new StorageManager(projectRoot);
  const markerPath = join(storage.paths.cache, 'bootstrap.done');

  if (existsSync(markerPath)) {
    return { bootstrappedNow: false, storage };
  }

  // 1. Protect raw transcripts in .gitignore automatically
  const gitignorePath = join(projectRoot, '.gitignore');
  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, 'utf8');
      if (!content.includes('.agentrunlog/raw/')) {
        appendFileSync(
          gitignorePath,
          '\n# AgentRunlog Raw Transcripts (Privacy Protected)\n.agentrunlog/raw/\n'
        );
      }
    } catch {}
  }

  // 2. Scan existing codebase (manifests, git history, modules, docs)
  const scanner = new CodebaseScanner(storage, projectRoot);
  scanner.scan();

  // 3. Scan and import past conversations across all 4 platforms
  const importer = new HistoryImporter(storage, projectRoot);
  const importRes = await importer.importProjectHistory();

  if (importRes.importedFiles.length > 0) {
    const extractor = new TranscriptExtractor(storage, storage.config.compiler as any);
    for (const f of importRes.importedFiles) {
      await extractor.extractAndCompile(join(storage.paths.raw, f));
    }
  }

  // 4. Write bootstrap completion marker
  try {
    writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {}

  return { bootstrappedNow: true, storage };
}
