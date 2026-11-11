import { z } from 'zod';

export const ConfidenceLevelSchema = z.enum(['high', 'medium', 'low']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

// Evidence Reference (FR-06)
export const EvidenceSchema = z.object({
  sessionId: z.string(),
  turnIndex: z.number().optional(),
  line: z.number().optional(),
  timestamp: z.string(),
  snippet: z.string().optional(),
  hash: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// Decision Record (FR-03, FR-05, FR-06, FR-07)
export const DecisionStatusSchema = z.enum(['active', 'superseded', 'deprecated', 'draft']);
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;

export const DecisionSchema = z.object({
  id: z.string(), // e.g. DEC-001
  title: z.string(),
  status: DecisionStatusSchema.default('active'),
  decidedBy: z.string().default('user'), // who approved / decided
  author: z.enum(['user', 'agent', 'team']).default('agent'),
  context: z.string(), // problem, rationale, options considered
  choice: z.string(), // the explicit decision taken
  consequences: z.string().optional(), // trade-offs, constraints
  supersedes: z.array(z.string()).default([]),
  supersededBy: z.string().nullable().default(null),
  affectsModules: z.array(z.string()).default([]),
  evidence: EvidenceSchema,
  confidence: ConfidenceLevelSchema.default('high'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// RCA Record (FR-04, FR-05)
export const RCASchema = z.object({
  id: z.string(), // e.g. RCA-001
  title: z.string(),
  incident: z.string(), // symptom, error trace
  rootCause: z.string(), // why it happened
  resolution: z.string(), // how it was solved
  preventativeActions: z.array(z.string()).default([]),
  affectsFiles: z.array(z.string()).default([]),
  evidence: EvidenceSchema,
  confidence: ConfidenceLevelSchema.default('high'),
  createdAt: z.string(),
});
export type RCA = z.infer<typeof RCASchema>;

// Dead End Record (FR-05, FR-18, FR-20 - Soft Guardrail, Structural Only)
export const DeadEndSchema = z.object({
  id: z.string(), // e.g. DEAD-001
  title: z.string(),
  rootCauseType: z.enum(['architectural', 'limitation', 'incompatibility']).default('architectural'),
  approach: z.string(), // what was attempted
  whyFailed: z.string(), // reason for failure / error trace
  retryConditions: z.string(), // ZORUNLU: When it might be viable to retry (FR-20)
  affectsModules: z.array(z.string()).default([]),
  evidence: EvidenceSchema,
  confidence: ConfidenceLevelSchema.default('high'),
  createdAt: z.string(),
});
export type DeadEnd = z.infer<typeof DeadEndSchema>;

// Task / Work Done Record (FR-02, FR-05)
export const TaskSchema = z.object({
  id: z.string(), // e.g. TASK-001
  title: z.string(),
  summary: z.string(),
  filesModified: z.array(z.string()).default([]),
  status: z.enum(['completed', 'in_progress', 'abandoned']).default('completed'),
  evidence: EvidenceSchema,
  createdAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

// Run Record (FR-04, FR-05)
export const RunSchema = z.object({
  id: z.string(), // e.g. RUN-001
  command: z.string(),
  exitCode: z.number(),
  summary: z.string(),
  evidence: EvidenceSchema,
  createdAt: z.string(),
});
export type Run = z.infer<typeof RunSchema>;

// Raw Session Event (FR-01, NFR-01, NFR-05, NFR-09)
export const SupportedPlatformSchema = z.enum(['claude_code', 'antigravity', 'cursor', 'codex']);
export type SupportedPlatform = z.infer<typeof SupportedPlatformSchema>;

export const RawSessionEventSchema = z.object({
  sessionId: z.string(),
  platform: SupportedPlatformSchema,
  caller: z.string().optional(), // NFR-09: "agentrunlog-compiler" for recursion shield
  eventType: z.enum([
    'session_start',
    'prompt_submit',
    'pre_tool_use',
    'post_tool_use',
    'agent_response',
    'pre_compact',
    'session_end',
  ]),
  timestamp: z.string(),
  payload: z.record(z.unknown()),
});
export type RawSessionEvent = z.infer<typeof RawSessionEventSchema>;

// Pre-compiled Context Cache Schema (FR-19 - Sub-5ms hook push)
export const ActiveContextCacheSchema = z.object({
  version: z.number().default(1),
  lastUpdated: z.string(),
  activeDecisions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      choice: z.string(),
      affectsModules: z.array(z.string()),
    })
  ),
  recentDeadEnds: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      approach: z.string(),
      whyFailed: z.string(),
      retryConditions: z.string(),
      affectsModules: z.array(z.string()),
    })
  ),
  recentRCAs: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        incident: z.string(),
        resolution: z.string(),
      })
    )
    .default([]),
  estimatedTokens: z.number().default(0),
});
export type ActiveContextCache = z.infer<typeof ActiveContextCacheSchema>;

// Project Configuration Schema (PRD v1.1)
export const RunlogConfigSchema = z.object({
  version: z.number().default(1),
  storageDir: z.string().default('.agentrunlog'),
  maxPushTokens: z.number().default(800), // NFR-07 (800 token ceiling)
  minPushConfidence: ConfidenceLevelSchema.default('medium'), // NFR-08
  sanitizer: z
    .object({
      enabled: z.boolean().default(true),
      customPatterns: z.array(z.string()).default([]),
    })
    .default({ enabled: true, customPatterns: [] }),
  compiler: z
    .object({
      provider: z.enum(['local', 'cloud']).default('local'),
      model: z.string().default('fast-default'),
      endpoint: z.string().optional(),
      uncompiledTurnsThreshold: z.number().default(25), // NFR-06 batching threshold
    })
    .default({ provider: 'local', model: 'fast-default', uncompiledTurnsThreshold: 25 }),
});
export type RunlogConfig = z.infer<typeof RunlogConfigSchema>;

export type RecordType = 'decision' | 'rca' | 'dead_end' | 'task' | 'run';
export type AnyWikiRecord = Decision | RCA | DeadEnd | Task | Run;
