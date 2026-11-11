import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveStoragePaths, ensureStorageDirectories, type StoragePaths } from './paths.js';
import { SessionLogger } from './logger.js';
import { ContextCacheManager } from './cache.js';
import { WikiManager } from './wiki.js';
import { type RunlogConfig, RunlogConfigSchema } from '../types/schemas.js';
import { defaultSanitizer, Sanitizer } from '../sanitizer/index.js';

export class StorageManager {
  public paths: StoragePaths;
  public logger: SessionLogger;
  public cache: ContextCacheManager;
  public wiki: WikiManager;
  public config: RunlogConfig;

  constructor(projectRoot: string = process.cwd(), storageDir: string = '.agentrunlog') {
    this.paths = resolveStoragePaths(projectRoot, storageDir);
    ensureStorageDirectories(this.paths);

    this.config = this.loadOrCreateConfig();
    const sanitizer = this.config.sanitizer.enabled
      ? new Sanitizer(this.config.sanitizer.customPatterns)
      : defaultSanitizer;

    this.logger = new SessionLogger(this.paths, sanitizer);
    this.cache = new ContextCacheManager(this.paths);
    this.wiki = new WikiManager(this.paths);
  }

  private loadOrCreateConfig(): RunlogConfig {
    if (existsSync(this.paths.config)) {
      try {
        const raw = readFileSync(this.paths.config, 'utf8');
        return RunlogConfigSchema.parse(JSON.parse(raw));
      } catch (err) {
        console.warn('Could not parse config.json, using defaults:', err);
      }
    }
    const defaultConfig = RunlogConfigSchema.parse({});
    writeFileSync(this.paths.config, JSON.stringify(defaultConfig, null, 2), 'utf8');
    return defaultConfig;
  }
}

export * from './paths.js';
export * from './logger.js';
export * from './cache.js';
export * from './wiki.js';
