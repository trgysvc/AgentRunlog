import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { type StorageManager } from '../storage/index.js';
import { defaultSanitizer } from '../sanitizer/index.js';
import { TranscriptExtractor } from './extractor.js';
import { type Decision, type RCA, type Task } from '../types/schemas.js';

export interface ScanResult {
  detectedStacks: string[];
  indexedModules: string[];
  decisionsCreated: number;
  rcasCreated: number;
  tasksCreated: number;
  durationMs: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agentrunlog',
  '.agents',
  '.claude',
  '.cursor',
  '.codex',
  'dist',
  'build',
  '.next',
  '.expo',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.gradle',
  'ios',
  'android',
]);

function bootId(prefix: string, seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 6).toUpperCase();
  return `${prefix}-${hash}`;
}

export class CodebaseScanner {
  private storage: StorageManager;
  private projectRoot: string;

  constructor(storage: StorageManager, projectRoot: string = process.cwd()) {
    this.storage = storage;
    this.projectRoot = projectRoot;
  }

  /**
   * Scans an existing repository to bootstrap initial engineering memory (Tech Stack, Modules, Git History, Docs).
   */
  public scan(): ScanResult {
    const start = Date.now();
    const now = new Date().toISOString();
    const evidence = {
      sessionId: 'bootstrap-scan',
      timestamp: now,
    };

    const detectedStacks: string[] = [];
    const decisions: Decision[] = [];
    const rcas: RCA[] = [];
    const tasks: Task[] = [];

    // 1. Scan Tech Stack Manifests
    this.scanNodePackageJson(detectedStacks, decisions, evidence, now);
    this.scanPythonManifests(detectedStacks, decisions, evidence, now);
    this.scanFlutterPubspec(detectedStacks, decisions, evidence, now);
    this.scanRustCargo(detectedStacks, decisions, evidence, now);
    this.scanGoMod(detectedStacks, decisions, evidence, now);
    this.scanDocker(detectedStacks, decisions, evidence, now);

    // 2. Discover Source Modules (FR-08)
    const indexedModules = this.discoverModules();
    if (indexedModules.length > 0 && decisions.length > 0) {
      decisions[0].affectsModules = indexedModules.slice(0, 8);
    }

    // 3. Scan Existing Project Documentation (README.md, CLAUDE.md, DEVLOG.md)
    this.scanExistingDocs(decisions, evidence, indexedModules, now);

    // 4. Scan Git Commit History (Recent Architecture & Fixes)
    this.scanGitHistory(rcas, tasks, evidence, now);

    // 5. Save all bootstrapped records & rebuild index + cache
    // Scanned facts have no transcript evidence (FR-06): keep them as drafts so they never crowd the push budget.
    for (const dec of decisions) {
      this.storage.wiki.saveDecision({ ...dec, status: 'draft' });
    }
    for (const rca of rcas) {
      this.storage.wiki.saveRCA({ ...rca, status: 'draft' });
    }
    for (const task of tasks) {
      this.storage.wiki.saveTask(task);
    }

    // Create module overview tasks/entries so wiki/modules/*.md pages are generated for every module
    if (indexedModules.length > 0 && decisions.length === 0) {
      this.storage.wiki.saveDecision({
        id: bootId('DEC', 'project-structure'),
        title: 'Established Project Directory Structure',
        status: 'draft',
        decidedBy: 'existing-codebase',
        author: 'team',
        context: 'Initial codebase scan discovered active project modules.',
        choice: `Modules located at: ${indexedModules.join(', ')}`,
        supersedes: [],
        supersededBy: null,
        affectsModules: indexedModules,
        evidence,
        confidence: 'high',
        createdAt: now,
        updatedAt: now,
      });
    }

    this.storage.wiki.generateIndexAndModules();
    const extractor = new TranscriptExtractor(this.storage);
    extractor.refreshActiveContextCache();

    return {
      detectedStacks,
      indexedModules,
      decisionsCreated: decisions.length,
      rcasCreated: rcas.length,
      tasksCreated: tasks.length,
      durationMs: Date.now() - start,
    };
  }

  private scanNodePackageJson(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    const pkgPath = join(this.projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      const devDeps = Object.keys(pkg.devDependencies || {});
      const allDeps = [...deps, ...devDeps];

      const keyFrameworks: string[] = [];
      const notable = [
        'next', 'react', 'react-native', 'expo', 'vue', 'nuxt', 'svelte', 'express',
        'fastify', 'nestjs', '@nestjs/core', 'hono', 'prisma', 'drizzle-orm', 'mongoose',
        'typeorm', 'tailwindcss', 'typescript', 'vitest', 'jest', 'zod', 'supabase',
      ];
      for (const n of notable) {
        if (allDeps.includes(n)) keyFrameworks.push(n);
      }

      detectedStacks.push('Node.js / JavaScript / TypeScript');
      const scripts = Object.keys(pkg.scripts || {}).join(', ');

      decisions.push({
        id: bootId('DEC', 'stack-nodejs'),
        title: `Tech Stack: Node.js (${keyFrameworks.slice(0, 5).join(', ') || 'JavaScript'})`,
        status: 'active',
        decidedBy: 'existing-codebase',
        author: 'team',
        context: `Detected package.json (${pkg.name || 'app'}) with ${deps.length} dependencies and scripts: ${scripts || 'none'}.`,
        choice: `Built on Node.js with core libraries: ${keyFrameworks.join(', ') || deps.slice(0, 10).join(', ')}`,
        consequences: scripts ? `Available npm scripts: ${scripts}` : undefined,
        supersedes: [],
        supersededBy: null,
        affectsModules: [],
        evidence,
        confidence: 'high',
        createdAt: now,
        updatedAt: now,
      });
    } catch {}
  }

  private scanPythonManifests(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    const pyproject = join(this.projectRoot, 'pyproject.toml');
    const reqs = join(this.projectRoot, 'requirements.txt');
    if (!existsSync(pyproject) && !existsSync(reqs)) return;

    try {
      const rawContent = existsSync(pyproject)
        ? readFileSync(pyproject, 'utf8')
        : readFileSync(reqs, 'utf8');
      const clean = defaultSanitizer.redactText(rawContent).toLowerCase();

      const frameworks: string[] = [];
      for (const f of ['fastapi', 'django', 'flask', 'sqlalchemy', 'pydantic', 'celery', 'pytest', 'alembic', 'uvicorn', 'torch', 'numpy']) {
        if (clean.includes(f)) frameworks.push(f);
      }

      detectedStacks.push('Python');
      decisions.push({
        id: bootId('DEC', 'stack-python'),
        title: `Tech Stack: Python (${frameworks.slice(0, 4).join(', ') || 'Standard'})`,
        status: 'active',
        decidedBy: 'existing-codebase',
        author: 'team',
        context: `Detected Python project manifest (${existsSync(pyproject) ? 'pyproject.toml' : 'requirements.txt'}).`,
        choice: `Python backend/app utilizing: ${frameworks.join(', ') || 'core Python libraries'}`,
        supersedes: [],
        supersededBy: null,
        affectsModules: [],
        evidence,
        confidence: 'high',
        createdAt: now,
        updatedAt: now,
      });
    } catch {}
  }

  private scanFlutterPubspec(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    const pubspec = join(this.projectRoot, 'pubspec.yaml');
    if (!existsSync(pubspec)) return;

    try {
      const raw = readFileSync(pubspec, 'utf8');
      detectedStacks.push('Flutter / Dart');
      decisions.push({
        id: bootId('DEC', 'stack-flutter'),
        title: 'Tech Stack: Flutter / Dart Cross-Platform App',
        status: 'active',
        decidedBy: 'existing-codebase',
        author: 'team',
        context: 'Detected pubspec.yaml in repository root.',
        choice: `Flutter application (${raw.includes('riverpod') ? 'Riverpod' : raw.includes('bloc') ? 'BLoC' : raw.includes('provider') ? 'Provider' : 'Dart'})`,
        supersedes: [],
        supersededBy: null,
        affectsModules: ['lib/**'],
        evidence,
        confidence: 'high',
        createdAt: now,
        updatedAt: now,
      });
    } catch {}
  }

  private scanRustCargo(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    if (!existsSync(join(this.projectRoot, 'Cargo.toml'))) return;
    detectedStacks.push('Rust');
    decisions.push({
      id: bootId('DEC', 'stack-rust'),
      title: 'Tech Stack: Rust (Cargo)',
      status: 'active',
      decidedBy: 'existing-codebase',
      author: 'team',
      context: 'Detected Cargo.toml in repository root.',
      choice: 'Rust systems/service project managed via Cargo.',
      supersedes: [],
      supersededBy: null,
      affectsModules: ['src/**'],
      evidence,
      confidence: 'high',
      createdAt: now,
      updatedAt: now,
    });
  }

  private scanGoMod(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    if (!existsSync(join(this.projectRoot, 'go.mod'))) return;
    detectedStacks.push('Go');
    decisions.push({
      id: bootId('DEC', 'stack-go'),
      title: 'Tech Stack: Go Modules',
      status: 'active',
      decidedBy: 'existing-codebase',
      author: 'team',
      context: 'Detected go.mod in repository root.',
      choice: 'Go service/CLI managed via Go Modules.',
      supersedes: [],
      supersededBy: null,
      affectsModules: [],
      evidence,
      confidence: 'high',
      createdAt: now,
      updatedAt: now,
    });
  }

  private scanDocker(
    detectedStacks: string[],
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    const hasDocker =
      existsSync(join(this.projectRoot, 'Dockerfile')) ||
      existsSync(join(this.projectRoot, 'docker-compose.yml')) ||
      existsSync(join(this.projectRoot, 'compose.yaml'));

    if (!hasDocker) return;
    detectedStacks.push('Docker');
    decisions.push({
      id: bootId('DEC', 'infra-docker'),
      title: 'Containerized Infrastructure (Docker)',
      status: 'active',
      decidedBy: 'existing-codebase',
      author: 'team',
      context: 'Detected Dockerfile or docker-compose configuration.',
      choice: 'Services are containerized and orchestrated using Docker.',
      supersedes: [],
      supersededBy: null,
      affectsModules: [],
      evidence,
      confidence: 'high',
      createdAt: now,
      updatedAt: now,
    });
  }

  private discoverModules(): string[] {
    const candidateRoots = ['src', 'app', 'lib', 'packages', 'services', 'api', 'backend'];
    const modules: string[] = [];

    for (const root of candidateRoots) {
      const absRoot = join(this.projectRoot, root);
      if (!existsSync(absRoot)) continue;

      try {
        const entries = readdirSync(absRoot);
        let hasDirectFiles = false;
        for (const entry of entries) {
          if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
          const full = join(absRoot, entry);
          const st = statSync(full);
          if (st.isDirectory()) {
            modules.push(`${root}/${entry}/**`);
          } else {
            hasDirectFiles = true;
          }
        }
        if (hasDirectFiles && modules.length === 0) {
          modules.push(`${root}/**`);
        }
      } catch {}
    }

    return modules;
  }

  private scanExistingDocs(
    decisions: Decision[],
    evidence: { sessionId: string; timestamp: string },
    modules: string[],
    now: string
  ): void {
    const docFiles = ['CLAUDE.md', 'AGENTS.md', 'README.md'];
    for (const doc of docFiles) {
      const fullPath = join(this.projectRoot, doc);
      if (!existsSync(fullPath)) continue;

      try {
        const raw = readFileSync(fullPath, 'utf8');
        const clean = defaultSanitizer.redactText(raw);
        // Extract first 600 chars meaningful summary
        const summary = clean
          .split('\n')
          .filter((l) => l.trim().length > 0 && !l.startsWith('!['))
          .slice(0, 12)
          .join(' ')
          .slice(0, 500);

        if (summary.length > 30) {
          decisions.push({
            id: bootId('DEC', `doc-${doc}`),
            title: `Project Overview & Guidelines (from ${doc})`,
            status: 'active',
            decidedBy: 'existing-codebase',
            author: 'team',
            context: `Imported baseline architectural context from ${doc}.`,
            choice: summary,
            supersedes: [],
            supersededBy: null,
            affectsModules: modules.slice(0, 5),
            evidence,
            confidence: 'medium',
            createdAt: now,
            updatedAt: now,
          });
          break; // Take highest priority doc summary to avoid token bloat
        }
      } catch {}
    }
  }

  private scanGitHistory(
    rcas: RCA[],
    tasks: Task[],
    evidence: { sessionId: string; timestamp: string },
    now: string
  ): void {
    if (!existsSync(join(this.projectRoot, '.git'))) return;

    try {
      const logOutput = execSync('git log -n 30 --oneline', {
        cwd: this.projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      const lines = logOutput.split('\n').filter((l) => l.trim().length > 0);
      const fixCommits: string[] = [];
      const recentCommits: string[] = [];

      for (const line of lines) {
        const cleanLine = defaultSanitizer.redactText(line.trim());
        recentCommits.push(cleanLine);
        if (/^[a-f0-9]+\s+(?:fix|bug|hotfix|patch|resolve)/i.test(cleanLine)) {
          fixCommits.push(cleanLine);
        }
      }

      if (fixCommits.length > 0) {
        rcas.push({
          id: bootId('RCA', 'git-history-fixes'),
          title: `Historical Bug Fixes (${fixCommits.length} recent fix commits)`,
          incident: 'Previous defects resolved in repository git history',
          rootCause: 'Documented across recent fix commits prior to AgentRunlog installation',
          resolution: fixCommits.slice(0, 8).join(' | '),
          preventativeActions: ['Consult git log for detailed diff if touching these areas'],
          affectsFiles: [],
          evidence,
          confidence: 'medium',
          createdAt: now,
        });
      }

      if (recentCommits.length > 0) {
        tasks.push({
          id: bootId('TASK', 'git-history-momentum'),
          title: `Recent Repository Activity (${recentCommits.length} commits)`,
          summary: `Latest commits prior to AgentRunlog setup:\n${recentCommits.slice(0, 12).map((c) => `- ${c}`).join('\n')}`,
          filesModified: [],
          status: 'completed',
          evidence,
          createdAt: now,
        });
      }
    } catch {}
  }
}
