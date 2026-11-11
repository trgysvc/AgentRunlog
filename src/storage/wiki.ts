import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import {
  type Decision,
  DecisionSchema,
  type RCA,
  RCASchema,
  type DeadEnd,
  DeadEndSchema,
  type Task,
  TaskSchema,
  type Run,
  RunSchema,
} from '../types/schemas.js';
import { type StoragePaths } from './paths.js';

export class WikiManager {
  private paths: StoragePaths;

  constructor(paths: StoragePaths) {
    this.paths = paths;
  }

  /**
   * Atomically writes markdown file with YAML frontmatter via temp file + rename.
   */
  private atomicWriteMarkdown(filePath: string, frontmatter: Record<string, unknown>, content: string): void {
    const fileContent = matter.stringify(content, frontmatter);
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      writeFileSync(tempPath, fileContent, 'utf8');
      renameSync(tempPath, filePath);
    } catch (err) {
      if (tempPath) {
        try {
          unlinkSync(tempPath);
        } catch {}
      }
      throw err;
    }
  }

  // Decisions
  public saveDecision(decision: Decision): void {
    const valid = DecisionSchema.parse(decision);
    const filePath = join(this.paths.decisions, `${valid.id}.md`);
    const content = `## Context\n${valid.context}\n\n## Choice\n${valid.choice}\n\n## Consequences\n${valid.consequences || 'None noted.'}`;
    this.atomicWriteMarkdown(filePath, valid as unknown as Record<string, unknown>, content);
  }

  public listDecisions(): Decision[] {
    try {
      const files = readdirSync(this.paths.decisions).filter((f) => f.endsWith('.md'));
      const results: Decision[] = [];
      for (const file of files) {
        const raw = readFileSync(join(this.paths.decisions, file), 'utf8');
        const parsed = matter(raw);
        const res = DecisionSchema.safeParse(parsed.data);
        if (res.success) results.push(res.data);
      }
      return results;
    } catch {
      return [];
    }
  }

  // RCA
  public saveRCA(rca: RCA): void {
    const valid = RCASchema.parse(rca);
    const filePath = join(this.paths.rca, `${valid.id}.md`);
    const content = `## Incident\n${valid.incident}\n\n## Root Cause\n${valid.rootCause}\n\n## Resolution\n${valid.resolution}\n\n## Preventative Actions\n${valid.preventativeActions.map((a) => `- ${a}`).join('\n')}`;
    this.atomicWriteMarkdown(filePath, valid as unknown as Record<string, unknown>, content);
  }

  public listRCAs(): RCA[] {
    try {
      const files = readdirSync(this.paths.rca).filter((f) => f.endsWith('.md'));
      const results: RCA[] = [];
      for (const file of files) {
        const raw = readFileSync(join(this.paths.rca, file), 'utf8');
        const parsed = matter(raw);
        const res = RCASchema.safeParse(parsed.data);
        if (res.success) results.push(res.data);
      }
      return results;
    } catch {
      return [];
    }
  }

  // DeadEnds
  public saveDeadEnd(deadEnd: DeadEnd): void {
    const valid = DeadEndSchema.parse(deadEnd);
    const filePath = join(this.paths.deadEnds, `${valid.id}.md`);
    const content = `## Approach\n${valid.approach}\n\n## Why It Failed\n${valid.whyFailed}\n\n## Retry Conditions\n${valid.retryConditions}`;
    this.atomicWriteMarkdown(filePath, valid as unknown as Record<string, unknown>, content);
  }

  public listDeadEnds(): DeadEnd[] {
    try {
      const files = readdirSync(this.paths.deadEnds).filter((f) => f.endsWith('.md'));
      const results: DeadEnd[] = [];
      for (const file of files) {
        const raw = readFileSync(join(this.paths.deadEnds, file), 'utf8');
        const parsed = matter(raw);
        const res = DeadEndSchema.safeParse(parsed.data);
        if (res.success) results.push(res.data);
      }
      return results;
    } catch {
      return [];
    }
  }

  // Tasks
  public saveTask(task: Task): void {
    const valid = TaskSchema.parse(task);
    const filePath = join(this.paths.tasks, `${valid.id}.md`);
    const content = `## Summary\n${valid.summary}\n\n## Files Modified\n${valid.filesModified.map((f) => `- \`${f}\``).join('\n')}`;
    this.atomicWriteMarkdown(filePath, valid as unknown as Record<string, unknown>, content);
  }

  // Runs
  public saveRun(run: Run): void {
    const valid = RunSchema.parse(run);
    const filePath = join(this.paths.runs, `${valid.id}.md`);
    const content = `## Command\n\`\`\`bash\n${valid.command}\n\`\`\`\n\n## Exit Code: ${valid.exitCode}\n\n## Summary\n${valid.summary}`;
    this.atomicWriteMarkdown(filePath, valid as unknown as Record<string, unknown>, content);
  }
}
