import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type StorageManager } from '../storage/index.js';

export interface LintIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  recordId: string;
  recordType: 'decision' | 'rca' | 'dead_end';
  message: string;
  details?: Record<string, unknown>;
}

export interface LintReport {
  timestamp: string;
  totalRecords: number;
  issueCount: {
    errors: number;
    warnings: number;
    info: number;
  };
  issues: LintIssue[];
}

export class WikiLinter {
  private storage: StorageManager;
  private projectRoot: string;

  constructor(storage: StorageManager, projectRoot: string = process.cwd()) {
    this.storage = storage;
    this.projectRoot = projectRoot;
  }

  /**
   * Run comprehensive health check on all wiki records (FR-11)
   */
  public lint(): LintReport {
    const issues: LintIssue[] = [];
    const decisions = this.storage.wiki.listDecisions();
    const rcas = this.storage.wiki.listRCAs();
    const deadEnds = this.storage.wiki.listDeadEnds();

    const decisionMap = new Map(decisions.map((d) => [d.id, d]));

    // 1. Lint Decisions
    for (const dec of decisions) {
      // Check broken supersedes links
      for (const supersededId of dec.supersedes) {
        if (!decisionMap.has(supersededId)) {
          issues.push({
            severity: 'error',
            code: 'BROKEN_SUPERSEDES_LINK',
            recordId: dec.id,
            recordType: 'decision',
            message: `Decision supersedes non-existent decision "${supersededId}".`,
          });
        }
      }

      // Check if superseded decision is marked active by mistake
      if (dec.supersededBy && dec.status === 'active') {
        issues.push({
          severity: 'error',
          code: 'SUPERSEDED_MARKED_ACTIVE',
          recordId: dec.id,
          recordType: 'decision',
          message: `Decision has supersededBy="${dec.supersededBy}" but status is still "active".`,
        });
      }

      // Check low confidence active decision
      if (dec.confidence === 'low' && dec.status === 'active') {
        issues.push({
          severity: 'warning',
          code: 'LOW_CONFIDENCE_ACTIVE',
          recordId: dec.id,
          recordType: 'decision',
          message: `Decision has low confidence but is marked active. Should be "draft".`,
        });
      }

      // Check stale module/file paths
      for (const mod of dec.affectsModules) {
        const cleanPath = mod.replace(/\/\*\*?$/, '');
        if (cleanPath.startsWith('src/') || cleanPath.startsWith('lib/')) {
          const absolute = join(this.projectRoot, cleanPath);
          if (!existsSync(absolute)) {
            issues.push({
              severity: 'warning',
              code: 'STALE_MODULE_REF',
              recordId: dec.id,
              recordType: 'decision',
              message: `Referenced module "${mod}" no longer exists on disk.`,
            });
          }
        }
      }
    }

    // 2. Lint RCAs
    for (const rca of rcas) {
      for (const file of rca.affectsFiles) {
        if (file.startsWith('src/') || file.startsWith('lib/')) {
          const absolute = join(this.projectRoot, file);
          if (!existsSync(absolute)) {
            issues.push({
              severity: 'info',
              code: 'RCA_HISTORICAL_FILE_MOVED',
              recordId: rca.id,
              recordType: 'rca',
              message: `File "${file}" referenced in RCA fix has been moved or deleted.`,
            });
          }
        }
      }
    }

    // 3. Lint DeadEnds
    for (const de of deadEnds) {
      if (!de.retryConditions || de.retryConditions.trim().length < 5) {
        issues.push({
          severity: 'error',
          code: 'MISSING_RETRY_CONDITIONS',
          recordId: de.id,
          recordType: 'dead_end',
          message: `DeadEnd record lacks required retry conditions (FR-20).`,
        });
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    const info = issues.filter((i) => i.severity === 'info').length;

    return {
      timestamp: new Date().toISOString(),
      totalRecords: decisions.length + rcas.length + deadEnds.length,
      issueCount: { errors, warnings, info },
      issues,
    };
  }
}
