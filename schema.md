# AgentRunlog — LLM Wiki Compiler Schema Contract (v1.1)

> This document defines the formal compilation rules for transforming raw session transcripts (`.agentrunlog/raw/`) into compiled engineering memory pages (`.agentrunlog/wiki/`).

---

## 1. Core Principles (Karpathy LLM Wiki Pattern)

1. **Raw Is Source of Truth:** Transcripts are immutable evidence. The wiki is a compiled view that can always be reconstructed from raw transcripts (`runlog reindex`).
2. **Strict Evidence Linkage:** Every single extracted record MUST link back to the exact transcript turn or line (`evidence: { sessionId, line, turnIndex, hash }`). Speculative claims without transcript evidence must be discarded or marked `confidence: "low"`.
3. **No False Dead-Ends (The Soft Guardrail):**
   - Transient errors (network drop, 503, temporary rate limit, simple typo) are **NEVER** marked as `DeadEnd`.
   - Only structural or architectural incompatibilities can be marked as `DeadEnd`.
   - Every `DeadEnd` record **MUST** include clear `retryConditions`.
   - Dead-ends are warnings; they never hard-block the agent.
4. **Supersede Determinism:**
   - When a new decision overrides an earlier one, the new decision lists the old decision in `supersedes: ["DEC-XXX"]`.
   - The old decision's file is updated with `status: "superseded"` and `supersededBy: "DEC-YYY"`.
   - Superseded decisions are excluded from push context caches.

---

## 2. Record Specifications

### 2.1 Decision (`wiki/decisions/DEC-*.md`)
Frontmatter:
```yaml
id: DEC-001
title: "Adoption of Model Context Protocol for Agent Retrieval"
status: active # active | superseded | deprecated | draft
decidedBy: "Turgay" # who authorized the choice
author: "team" # user | agent | team
supersedes: []
supersededBy: null
affectsModules: ["src/mcp/**", "src/hooks/**"]
confidence: high # high | medium | low
evidence:
  sessionId: "session-2026-11-11-01"
  turnIndex: 14
  timestamp: "2026-11-11T16:00:00Z"
createdAt: "2026-11-11T16:00:00Z"
updatedAt: "2026-11-11T16:00:00Z"
```
Body Markdown Sections:
- `## Context`: Problem description, constraints, and alternative choices considered.
- `## Choice`: Explicit decision taken.
- `## Consequences`: Trade-offs and follow-up requirements.

---

### 2.2 Root Cause Analysis (`wiki/rca/RCA-*.md`)
Frontmatter:
```yaml
id: RCA-001
title: "Synchronous Hook Event Loop Freeze on Slow FS Call"
affectsFiles: ["src/hooks/claude-code.ts"]
confidence: high
evidence:
  sessionId: "session-2026-11-11-02"
  turnIndex: 32
  timestamp: "2026-11-11T16:20:00Z"
createdAt: "2026-11-11T16:20:00Z"
```
Body Markdown Sections:
- `## Incident`: What broke or was observed (error logs, symptoms).
- `## Root Cause`: The technical reason why it happened.
- `## Resolution`: What exact fix was implemented.
- `## Preventative Actions`: Bulleted list of automated or architectural safeguards.

---

### 2.3 Dead End (`wiki/dead-ends/DEAD-*.md`)
Frontmatter:
```yaml
id: DEAD-001
title: "In-Hook Direct LLM Extraction"
rootCauseType: "architectural" # architectural | limitation | incompatibility
affectsModules: ["src/hooks/**"]
retryConditions: "Do not retry unless a local model responds in < 5ms."
confidence: high
evidence:
  sessionId: "session-2026-11-11-03"
  turnIndex: 5
  timestamp: "2026-11-11T16:35:00Z"
createdAt: "2026-11-11T16:35:00Z"
```
Body Markdown Sections:
- `## Approach`: What was tried.
- `## Why It Failed`: Exact failure trace or latency numbers.
- `## Retry Conditions`: What specific condition would make this approach feasible again.

---

### 2.4 Task / Work Done (`wiki/tasks/TASK-*.md`)
Tracks units of work with status (`completed` / `in_progress` when the session ended with an unresolved failure or failing last run) and affected files. Optional `commits`: short git hashes made during the session (compile-time `git log`, omitted without a repo).

### 2.5 Run (`wiki/runs/RUN-*.md`)
Tracks build, test, or benchmark execution outputs.

---

## 3. Active Context Cache Compilation (`cache/active_context.json`)
The compiler synthesizes all active records into a single cache file with:
- Top active decisions (`status == 'active'` and `confidence != 'low'`).
- Recent dead ends to warn against.
- `lastSession`: capped (~400 char) handoff of the most recent session: last request, touched files, open work.
- `verified`: latest passing test/build/lint/typecheck command per kind.
- Records whose every cited file was deleted or renamed are excluded (still in the wiki; `lint` reports `STALE_CODE_REF`).
- Strict token ceiling: **800 tokens** maximum, measured on the exact injected text (drops verified commands, RCAs, decisions, dead ends, then the handoff, in that order).

Side caches written at compile time: `cache/last_session.json`, `cache/guard_index.json` (command-keyed fixes/dead ends the hook injects on a command's 2nd failure in one session; all four platforms, advisory; Antigravity defers delivery to the next PreInvocation via `cache/pending_guard.json`).


## Addendum: auto-lint and opt-in conflict review
- Every compile/reindex writes `cache/lint.json` (counts + first 20 issues).
- `config.json` `llmReview {enabled=false, consentAt}`: when enabled, `active_context.json` may carry `conflictReview` (≤2 pairs of active decisions sharing `affectsModules`); `review_decision_conflict` (MCP) records the verdict; reviewed pairs live in `cache/reviewed_pairs.json`. AgentRunlog itself never calls a model.
