# AgentRunlog 🧠⚡

> **Typed Engineering Memory & Karpathy LLM Wiki for Autonomous Coding Agents.**  
> Never let your coding agents make the same mistake twice.

[![Target Platforms](https://img.shields.io/badge/Platforms-Claude_Code_|_Antigravity_|_Codex_|_Cursor-8A2BE2)](#supported-platforms)
[![Architecture](https://img.shields.io/badge/Architecture-LLM_Wiki_Pattern-success)](#architecture)
[![Interface](https://img.shields.io/badge/Integration-Hooks_+_MCP-blue)](#how-it-works)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 📌 Problem & Vision

Across coding sessions, **context is lost**:
- 🔄 **Re-invented wheels & reversed decisions**: The agent forgets why an architectural choice was made and reverts it.
- 🕳️ **Dead-end traps**: The agent repeatedly attempts failed solutions, debugging methods, or broken libraries.
- 📉 **Wasted time & tokens**: Every session starts with an amnesic agent requiring manual context re-feeding.

**AgentRunlog** solves this by implementing Andrej Karpathy's **LLM Wiki Pattern** tailored specifically for coding agents. It captures raw transcripts, automatically sanitizes sensitive data, compiles events into **typed engineering artifacts**, and serves this memory back to agents via **push** (hooks) and **pull** (MCP).

---

## 🎯 Supported Platforms

AgentRunlog acts as a non-intrusive context layer across the 4 major coding platforms:

| Platform | Hooks registered | Context injection | Repeated-failure guard |
| :--- | :--- | :--- | :--- |
| **Claude Code** | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `SessionEnd` | `SessionStart` stdout | `PostToolUseFailure` → `additionalContext` |
| **Google Antigravity** | `SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, `Stop` | `SessionStart` → `injectSteps` | stashed, delivered at next `PreInvocation` |
| **Cursor** | `sessionStart`, `beforeSubmitPrompt`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `preCompact`, `stop` (+ always-on rule) | `sessionStart` → `additional_context`; rule + MCP pull as fallback | `postToolUseFailure` → `additional_context` |
| **Codex CLI** | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` | `SessionStart` output | `PostToolUse` → `additionalContext` (hooks must be trusted in `/hooks`) |

📖 **Per-platform setup, behaviour and troubleshooting:** [docs/PLATFORM_GUIDE.md](docs/PLATFORM_GUIDE.md)

---

## 🏛️ Architecture: The 3-Tier Karpathy Wiki

```
┌────────────────────────────────────────────────────────────────────────┐
│                        AGENT RUNTIME ENVIRONMENT                       │
│              (Claude Code  /  Antigravity  /  Codex  /  Cursor)        │
└───────────────────▲────────────────────────────────┬───────────────────┘
                    │                                │
            Context Push / MCP Pull           Hooks Capture (Thin Adapter)
                    │                                │
                    │                     [ Secrets Sanitization ]
                    │                                │
                    │                                ▼
┌───────────────────┴───────────────────┐    ┌───────────────────────────┐
│              WIKI LAYER               │    │         RAW LAYER         │
│          (.agentrunlog/wiki/)         │    │    (.agentrunlog/raw/)    │
│                                       │    │                           │
│  ├── index.md        (Module Map)     │    │  • Immutable Transcripts  │
│  ├── decisions/      (Supersedes)     │◄───┤  • Session JSONL Logs     │
│  ├── rca/            (Bug & Fixes)    │    │  • Redacted Secrets       │
│  ├── dead-ends/      (Failed Trials)  │    └───────────────────────────┘
│  └── tasks/          (Work Log)       │                  ▲
└───────────────────▲───────────────────┘                  │
                    │                             Asynchronous Compiler
            Periodic Linter                      (Deterministic Compiler)
          (Staleness & Conflicts)
```

1. **`raw/` (Immutable Transcripts):** Exact session dialogs and tool executions, stripped of API keys, tokens, and credentials before hitting disk.
2. **`wiki/` (Compiled Typed Memory):** Structured, git-trackable Markdown records linked back to raw transcript evidence with confidence scores.
3. **`schema.md` (Strict Typing Contract):** The exact specifications directing the compiler worker on how to classify and update knowledge.

---

## 🏷️ Typed Engineering Memory

Unlike generic semantic vector stores that dump unstructured text, AgentRunlog organizes knowledge into strict engineering records:

- ⚖️ **`Decision`**: Architecture and design decisions, trade-offs, and `supersedes` relations to prevent decision churn.
- 🔍 **`RCA` (Root Cause Analysis)**: Deep root-cause breakdowns of tricky bugs and verified resolutions.
- ⛔ **`DeadEnd` (Failed Attempts)**: Explicit records of approaches that failed, why they failed, and the conditions required to re-attempt.
- 📋 **`Task / Work Done`**: Chronological log of changes and feature completions.
- 🧪 **`Run`**: Benchmark, build, or test run outcomes verifying claims.

---

## 🔄 How It Works

### 1. Push (Proactive Injection — ~30ms hook, Node-startup bound)
When a new agent session starts, AgentRunlog reads `.agentrunlog/cache/active_context.json` (`< 5ms`) and injects high-priority context:
- Active architectural decisions (automatically excluding `superseded` ones).
- Known dead ends with explicit `retryConditions` (Soft Guardrail — warns without blocking).
- Recent root cause analyses (RCAs) for fast failure recall.
- A short handoff of the last session (open work) and the latest verified test/build/lint commands.
- Strictly capped at **800 tokens** to prevent context pollution.

### 2. Pull & Live Record (MCP Server)
Agents can actively query and record memory across workspaces (`projectRoot`) via native MCP tools:
- `search_runlog(query, types, module)`: Keyword & module-filtered search across decisions, RCAs, and dead ends.
- `get_decision(id)` / `get_rca(id)`: Retrieve full context, rationale, evidence, and supersede graph.
- `check_dead_ends(approach, module)`: Non-blocking Soft Guardrail check with retry conditions.
- `get_active_context()`: Instant pre-compiled project summary.
- `record_decision` / `record_dead_end` / `record_rca`: Autonomous live recording during active conversations.

### 3. Session Journeys
Every compiled session also gets a deterministic page, `wiki/runs/<session>.md`: what was asked, which files changed, which commands ran, and which errors were later resolved (failed command → passing run, with the files edited in between). Full text stays in `raw/`; the page points back by turn number. No model is involved.

### 4. Periodic Linting
The linter runs **automatically after every compile/reindex** (result in `cache/lint.json`, summarized by `runlog report`); `runlog lint` prints the full list on demand.
- Flags records citing deleted or moved files (`STALE_CODE_REF`, `STALE_MODULE_REF`); such records are also kept out of the push.
- Flags broken `supersedes` links, superseded decisions still marked active, low-confidence active decisions, and dead ends without retry conditions.
- **Optional, off by default — LLM decision-conflict review.** Detecting a *semantic* contradiction between two active decisions needs a model. AgentRunlog never calls one itself, so this uses your coding agent's own model and **spends your tokens**. Enable it explicitly with `runlog llm-review enable` (shows the cost warning and asks for confirmation; `--yes` to confirm non-interactively); `runlog llm-review disable` turns it off, `status` shows the state. When on, the compiler deterministically picks up to 2 pairs of active decisions that touch the same module (~150–250 extra tokens per session) and the push asks your agent to compare them, ask you which one stands, and report via the `review_decision_conflict` MCP tool (the loser becomes `superseded`; "compatible" pairs are never asked again). The tool refuses to act while the feature is disabled.

### 5. Handoff, Guardrail & Verification (no model, no SessionEnd dependency)

- **Last session handoff** and **verified commands** are pushed at session start (within the 800-token ceiling).
- **Repeated-failure guard**: the 2nd failure of the same command in a session injects the known RCA / dead end on all four platforms, advisory only (see table).
- **Code sync**: records whose cited files were all deleted are not pushed and are flagged by `lint` / `report`.
- **Claim check**: "tests pass" claims without a passing run are flagged in the session journey and `report`.
- **Git link**: commits made during a session are attached to its task and journey page.

| Platform | Failure signal read | Advisory delivered via |
|---|---|---|
| Claude Code | `PostToolUseFailure` / `error` | `hookSpecificOutput.additionalContext` |
| Cursor | `postToolUseFailure` (`error_message`) | `additional_context` |
| Codex CLI | `PostToolUse` after a non-zero Bash exit (exit code parsed from `tool_response`) | `hookSpecificOutput.additionalContext` |
| Antigravity | `PostToolUse` `error` (its output must be `{}`) | stashed, then `injectSteps` at the next `PreInvocation` |

Platform notes: Antigravity cannot inject text from `PostToolUse`, so its advisory arrives at the next model call; Cursor's guard relies on the documented `postToolUseFailure` event; Codex requires hooks to be trusted once via `/hooks`. Details in [docs/PLATFORM_GUIDE.md](docs/PLATFORM_GUIDE.md).

Compilation never depends on `SessionEnd` (not every Claude session fires it): it also runs after 25 uncompiled turns, on `PreCompact`, and at the next session start if a previous session left turns behind.

---

## 🔒 Privacy & Safety First

- **Sanitization by Default**: Regular expressions and pattern matchers strip credentials, bearer tokens, and private keys *before* anything is written to `raw/`.
- **Git Safety**: Raw transcripts (`.agentrunlog/raw/`) are excluded from Git via `.gitignore`. Only the curated `wiki/` may be committed if team sharing is desired.
- **Originals are never touched**: past conversations are only *read* from each platform's own store. Only AgentRunlog's own copies in `.agentrunlog/raw/` are ever replaced, and only after the new copy is fully written.
- **No event loss, no truncation**: hook payloads have no size cap and imported conversations are stored in full. A payload that cannot be parsed is logged to `cache/hook-errors.log`, never silently dropped.
- **Automatic history sync**: on session start the hook refreshes past-conversation imports in the background (at most every 30 min); nothing to run by hand.
- **Opt-out & exclusions**: `runlog pause` / `runlog resume` (or `privacy.enabled=false` in `config.json`) stop all recording in a project; `privacy.excludePatterns` (globs) skip matching paths and commands.
- **Non-blocking Execution**: Hook adapters are dependency-free and small (~30ms, mostly Node startup), offloading compilation and extraction to background workers.

---

## 🤖 Dual-Agent Design & Zero-Cost Offline Compiler

AgentRunlog makes an intentional architectural distinction between the **Working Agent** and the **Compiler Worker**:

- **Working Agent (Claude Code, Google Antigravity, Cursor, Codex):** The primary AI coding assistant actively conversing with you, reading files, and writing code.
- **Compiler Worker (FR-10, NFR-06):** An asynchronous background process that parses raw JSONL session logs to extract structured decisions, RCAs, and dead ends without polluting the working agent's context.

> [!IMPORTANT]
> **Why an Out-of-Band Compiler?**  
> Forcing the working agent to simultaneously code and summarize hundreds of lines of chat history causes context bloat and mental fatigue (the primary pitfall observed in tools like Cline / Roo-Code). AgentRunlog offloads compilation to the background.
>
> **No model calls, ever:**  
> All 4 supported coding platforms already run their own frontier LLMs, and AgentRunlog never talks to a model itself. Hooks capture what the user and the agent said and did (prompts, tool runs, errors, files); `runlog compile` extracts typed records from that work with deterministic pattern recognition, and the agent itself can record decisions through the MCP tools. No API keys, no network.

---

## 🚀 Zero-Config Installation (One Command, All 4 Platforms)

AgentRunlog ships as a **Universal Plugin Bundle** (`plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`, and `skills/`).

### 1. Install Globally (Auto-Configures All 4 Platforms via `postinstall`)
```bash
npm install -g git+https://github.com/trgysvc/AgentRunlog.git
```

That's it! During global installation, `postinstall` automatically and non-destructively installs and configures **all 4 platforms** (you can also re-run `runlog setup` or `runlog doctor` anytime):
- 🟣 **Google Antigravity:** Native plugin (`~/.gemini/config/plugins/agentrunlog/`) with MCP, Hooks, `rules/AGENTS.md`, and `SKILL.md`.
- 🟠 **Claude Code:** Global MCP (`~/.claude.json`), Hooks (`~/.claude/settings.json`), and Skill (`~/.claude/skills/agentrunlog/`).
- 🔵 **Cursor IDE & CLI:** Global MCP (`~/.cursor/mcp.json`), Hooks (`~/.cursor/hooks.json`), and Rules (`~/.cursor/rules/agentrunlog.mdc`).
- 🟢 **OpenAI Codex CLI:** Global MCP & `features.hooks = true` (`~/.codex/config.toml`), Hooks (`~/.codex/hooks.json`), and `AGENTS.md`.

---

## 🛠️ How It Works Day-to-Day (100% Automatic)

You **never** need to remember `runlog init`, `runlog compile`, or *"save this"*!

### Step 1: Just Open Any Project & Start Coding
Open **any** project (new or halfway built) in Antigravity, Claude Code, Cursor, or Codex and start chatting:
- On the **very first hook or MCP call**, AgentRunlog automatically detects the project workspace, creates `.agentrunlog/`, secures `.gitignore`, scans the codebase (`package.json`, `git log`, `src/`), and imports past conversations across all 4 platforms in the background!

### Step 2: Work Normally (Zero User Effort)
You **never** need to say *"save this"* or *"update memory"*. Simply talk to your AI agent and code naturally:
- **Silent Capture & Secret Redaction:** Every prompt, tool run, and error is silently logged to `.agentrunlog/raw/` via hooks, with API keys and passwords stripped before hitting disk.
- **Autonomous Live Recording:** When you naturally confirm a choice (*"Let's use Drizzle ORM instead of Prisma"*), the plugin rules instruct the agent to silently call `record_decision` in the background.
- **History matching:** Claude Code transcripts are matched to a project by their recorded `cwd`, so a project never imports another project's conversations. A conversation keeps one record set (live and imported copies share the session id).
- **Explicit vs. guessed decisions:** decisions saved through `record_decision` are active immediately and survive `reindex`; decisions guessed from prompt keywords are always `draft` and never pushed.
- **Automatic Session Compilation:** After 25 uncompiled turns, on `PreCompact` / `SessionEnd`, or at the next session start (crash recovery), the detached background compiler automatically extracts Decisions, RCAs, and repeated-failure Dead Ends into `.agentrunlog/wiki/` and updates `active_context.json`.

### Step 3: Next Session (Automatic Memory Recall)
When you open a new chat tomorrow or switch between Claude Code, Antigravity, Cursor, and Codex:
- **Push:** On the first turn, the hook injects active decisions, recent RCAs, and dead ends (< 800 tokens, ~30ms).
- **Pull:** Before touching risky architecture, the agent automatically checks `check_dead_ends` and `search_runlog` via MCP so past mistakes are never repeated.

### Step 4: Maintenance & Verification Commands
```bash
runlog doctor    # Verify all 4 platform plugins + live MCP stdio handshake
runlog scan [--alias name] # Scan codebase + past conversations across all 4 platforms
runlog status    # View active/superseded decisions, RCAs, dead ends, and token budget
runlog compile   # Manually compile raw session transcripts into wiki pages
runlog lint      # Audit wiki for stale file paths, missing retry conditions, or broken links
runlog usage     # Disk space used by AgentRunlog, per folder
runlog scan --force  # Re-import every past conversation (full text, never truncated)
runlog report    # Impact report: sessions, injections, repeated failures, unverified claims, stale records
runlog pause     # Stop recording in this project (runlog resume to continue)
runlog llm-review enable|disable|status  # Opt-in conflict review by your agent's LLM (uses tokens, off by default)
runlog reindex   # Wipe wiki and rebuild from scratch from raw/ transcripts (NFR-10)
```

---

## 🗺️ Roadmap & Status

- [x] **Core Engine**: Typed record schemas (`schema.md`), atomic disk storage, and two-layer sanitization filter.
- [x] **MCP Server**: Local stdio MCP server with read (`search_runlog`, `get_decision`, `get_rca`, `check_dead_ends`, `get_active_context`) and live write (`record_decision`, `record_dead_end`, `record_rca`) tools.
- [x] **Native Plugin Bundles**: One-command Antigravity plugin installer (`runlog install-plugin`) and Claude Code plugin manifests.
- [x] **Capture Adapters**: Hook adapters for Claude Code, Google Antigravity, Cursor (own `.cursor/rules/agentrunlog.mdc`, never overwrites `.cursorrules`), and Codex CLI.
- [x] **Handoff, verified commands, claim check, code sync, git link, repeated-failure guard** on all four platforms (see section 5).
- [x] **Impact report, disk usage, pause/resume, exclude patterns, automatic history sync.**
- [x] Automatic lint after every compile; opt-in (default off, token-cost consent) LLM decision-conflict review via the working agent.
- [ ] Real-app verification of Cursor, Codex and Antigravity hooks (verified through the shipped hook with simulated payloads and the official docs; Claude Code verified end to end).
- [x] **Codebase Bootstrap Scanner**: Automatic project scan on `runlog init` / `runlog scan` for existing in-progress repos.
- [x] **Compiler Worker & Linter**: Deterministic offline compiler, `active_context.json` cache, `wiki/index.md` builder, `runlog lint`, and `runlog reindex`.

---

## 📄 License

MIT © [Turgay Savacı](https://github.com/trgysvc)
