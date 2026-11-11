import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface StoragePaths {
  root: string;
  config: string;
  raw: string;
  cache: string;
  activeContextCache: string;
  wiki: string;
  wikiIndex: string;
  decisions: string;
  rca: string;
  deadEnds: string;
  tasks: string;
  runs: string;
}

export function resolveStoragePaths(projectRoot: string = process.cwd(), storageDir: string = '.agentrunlog'): StoragePaths {
  const root = join(projectRoot, storageDir);
  const raw = join(root, 'raw');
  const cache = join(root, 'cache');
  const wiki = join(root, 'wiki');

  return {
    root,
    config: join(root, 'config.json'),
    raw,
    cache,
    activeContextCache: join(cache, 'active_context.json'),
    wiki,
    wikiIndex: join(wiki, 'index.md'),
    decisions: join(wiki, 'decisions'),
    rca: join(wiki, 'rca'),
    deadEnds: join(wiki, 'dead-ends'),
    tasks: join(wiki, 'tasks'),
    runs: join(wiki, 'runs'),
  };
}

export function ensureStorageDirectories(paths: StoragePaths): void {
  const dirs = [
    paths.root,
    paths.raw,
    paths.cache,
    paths.wiki,
    paths.decisions,
    paths.rca,
    paths.deadEnds,
    paths.tasks,
    paths.runs,
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
