import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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

function toModuleSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export class WikiManager {
  private paths: StoragePaths;
  private modulesDir: string;

  constructor(paths: StoragePaths) {
    this.paths = paths;
    this.modulesDir = join(paths.wiki, 'modules');
    if (!existsSync(this.modulesDir)) {
      mkdirSync(this.modulesDir, { recursive: true });
    }
  }

  /**
   * Atomically writes markdown file with YAML frontmatter via temp file + rename.
   */
  private atomicWriteMarkdown(filePath: string, frontmatter: Record<string, unknown>, content: string): void {
    // Strip undefined properties before js-yaml serialization
    const cleanFrontmatter = JSON.parse(JSON.stringify(frontmatter));
    const fileContent = matter.stringify(content, cleanFrontmatter);
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

  /**
   * Generates wiki/index.md and module-based context pages wiki/modules/*.md (FR-08)
   */
  public generateIndexAndModules(): void {
    const decisions = this.listDecisions();
    const deadEnds = this.listDeadEnds();
    const rcas = this.listRCAs();

    // 1. Group records by module
    const moduleMap = new Map<string, { decisions: Decision[]; deadEnds: DeadEnd[]; rcas: RCA[] }>();

    for (const dec of decisions) {
      for (const mod of dec.affectsModules) {
        const entry = moduleMap.get(mod) || { decisions: [], deadEnds: [], rcas: [] };
        entry.decisions.push(dec);
        moduleMap.set(mod, entry);
      }
    }

    for (const de of deadEnds) {
      for (const mod of de.affectsModules) {
        const entry = moduleMap.get(mod) || { decisions: [], deadEnds: [], rcas: [] };
        entry.deadEnds.push(de);
        moduleMap.set(mod, entry);
      }
    }

    for (const rca of rcas) {
      for (const f of rca.affectsFiles) {
        const entry = moduleMap.get(f) || { decisions: [], deadEnds: [], rcas: [] };
        entry.rcas.push(rca);
        moduleMap.set(f, entry);
      }
    }

    // 2. Generate wiki/modules/*.md files (FR-08)
    for (const [moduleName, items] of moduleMap.entries()) {
      const slug = toModuleSlug(moduleName);
      const modulePath = join(this.modulesDir, `${slug}.md`);

      const lines: string[] = [
        `# Module Memory: \`${moduleName}\`\n`,
        `> Auto-generated engineering context by AgentRunlog (FR-08)\n`,
      ];

      if (items.decisions.length > 0) {
        lines.push('## Active Decisions');
        for (const d of items.decisions) {
          lines.push(`- **[${d.id}](../decisions/${d.id}.md)**: ${d.title} (${d.status}) - Choice: ${d.choice}`);
        }
        lines.push('');
      }

      if (items.deadEnds.length > 0) {
        lines.push('## Known Dead Ends');
        for (const de of items.deadEnds) {
          lines.push(`- **[${de.id}](../dead-ends/${de.id}.md)**: ${de.title} - Failed: ${de.whyFailed} (Retry: ${de.retryConditions})`);
        }
        lines.push('');
      }

      if (items.rcas.length > 0) {
        lines.push('## Root Cause Analyses (RCA)');
        for (const r of items.rcas) {
          lines.push(`- **[${r.id}](../rca/${r.id}.md)**: ${r.title} - Resolution: ${r.resolution}`);
        }
        lines.push('');
      }

      writeFileSync(modulePath, lines.join('\n'), 'utf8');
    }

    // 3. Generate main wiki/index.md
    const activeDecisions = decisions.filter((d) => d.status === 'active');
    const draftDecisions = decisions.filter((d) => d.status === 'draft');
    const indexContent: string[] = [
      '# AgentRunlog Engineering Memory Wiki 🧠',
      '\n> Compiled knowledge base following Andrej Karpathy\'s LLM Wiki pattern.\n',
      '## Overview',
      `- **Active Decisions:** ${activeDecisions.length}`,
      `- **Draft / Historical Candidates:** ${draftDecisions.length}`,
      `- **Superseded Decisions:** ${decisions.filter((d) => d.status === 'superseded').length}`,
      `- **Known Dead Ends:** ${deadEnds.length}`,
      `- **Root Cause Analyses:** ${rcas.length}`,
      `- **Indexed Modules:** ${moduleMap.size}\n`,
      '## Active Decisions Index',
      '| ID | Title | Decided By | Affected Modules |',
      '| :--- | :--- | :--- | :--- |',
      ...activeDecisions.map(
        (d) => `| [${d.id}](decisions/${d.id}.md) | ${d.title} | ${d.decidedBy} | \`${d.affectsModules.join(', ') || 'Global'}\` |`
      ),
      ...(draftDecisions.length > 0
        ? [
            '\n## Historical Candidates (Draft — Unverified)',
            '| ID | Title | Confidence | Evidence Session |',
            '| :--- | :--- | :--- | :--- |',
            ...draftDecisions.map(
              (d) => `| [${d.id}](decisions/${d.id}.md) | ${d.title} | ${d.confidence} | ${d.evidence.sessionId} |`
            ),
          ]
        : []),
      '\n## Known Dead Ends (Soft Guardrail)',
      '| ID | Title | Why Failed | Retry Conditions |',
      '| :--- | :--- | :--- | :--- |',
      ...deadEnds.map(
        (de) => `| [${de.id}](dead-ends/${de.id}.md) | ${de.title} | ${de.whyFailed} | ${de.retryConditions} |`
      ),
      '\n## Root Cause Analyses (RCA)',
      '| ID | Title | Incident | Resolution |',
      '| :--- | :--- | :--- | :--- |',
      ...rcas.map(
        (r) => `| [${r.id}](rca/${r.id}.md) | ${r.title} | ${r.incident.replace(/\|/g, '/')} | ${r.resolution.replace(/\|/g, '/')} |`
      ),
      '\n## Module Context Directory (FR-08)',
      ...Array.from(moduleMap.keys()).map((m) => {
        const slug = toModuleSlug(m);
        return `- [\`${m}\`](modules/${slug}.md)`;
      }),
      '\n---',
      `*Last compiled: ${new Date().toISOString()} by AgentRunlog Compiler*`,
    ];

    writeFileSync(this.paths.wikiIndex, indexContent.join('\n'), 'utf8');
  }
}
