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
- 🔄 **Re-invented wheels & reversed decisions**: The agent forgets why a architectural choice was made and reverts it.
- 🕳️ **Dead-end traps**: The agent repeatedly attempts failed solutions, debugging methods, or broken libraries.
- 📉 **Wasted time & tokens**: Every session starts with an amnesic agent requiring manual context re-feeding.

**AgentRunlog** solves this by implementing Andrej Karpathy's **LLM Wiki Pattern** tailored specifically for coding agents. It captures raw transcripts, automatically sanitizes sensitive data, compiles events into **typed engineering artifacts**, and serves this memory back to agents via **push** (hooks) and **pull** (MCP).

---

## 🎯 Supported Platforms

AgentRunlog acts as a non-intrusive context layer across the 4 major coding platforms:

| Platform | Primary Integration | Injection Mechanism | Capture Event |
| :--- | :--- | :--- | :--- |
| **Claude Code** | Native Plugin Hooks (`hooks.json`) | `SessionStart`, `PreToolUse` | `UserPromptSubmit`, `PostToolUse`, `SessionEnd` |
| **Google Antigravity** | Agent Hooks & Extensions (`hooks.json`) | `PreInvocation` | `PostInvocation`, `Stop` |
| **Cursor** | Cursor Hooks (`hooks.json`) & Rules | Rules injection + MCP pull | `afterAgentResponse`, `preCompact`, `stop` |
| **Codex CLI** | CLI Hooks (`hooks.json`) | `SessionStart` | `PostToolUse`, `Stop` |

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
            Periodic Linter                      (LLM Extraction Worker)
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

### 1. Push (Proactive Injection)
When a new agent session starts or before a tool runs, AgentRunlog inspects the session context and automatically injects high-priority relevant facts:
- Recent active decisions for the current module.
- Dead ends to avoid for matching errors.
- Token-budgeted and filtered by relevance to avoid context pollution.

### 2. Pull (MCP Server)
Agents can actively query memory on demand using native MCP tools:
- `search_runlog(query, types)`: Semantic & keyword search across decisions, RCAs, and dead ends.
- `get_decision(decision_id)`: Retrieve full context, rationale, and superseded items.
- `check_dead_ends(approach_description)`: Check if an intended path has already failed before.

### 3. Periodic Linting
A lightweight linter periodically scans the wiki:
- Flags stale records referencing deleted or moved files.
- Detects conflicting decisions and marks outdated ones.

---

## 🔒 Privacy & Safety First

- **Sanitization by Default**: Regular expressions and pattern matchers strip credentials, bearer tokens, and private keys *before* anything is written to `raw/`.
- **Git Safety**: Raw transcripts (`.agentrunlog/raw/`) are excluded from Git via `.gitignore`. Only the curated `wiki/` may be committed if team sharing is desired.
- **Non-blocking Execution**: Hook adapters are designed to be sub-millisecond, offloading compilation and extraction to background workers.

---

## 🚀 Quick Start & Installation

### 1. Install Globally (from GitHub or Release Tarball)
```bash
# Directly from GitHub
npm install -g git+https://github.com/trgysvc/AgentRunlog.git

# Or from the latest GitHub Release tarball
npm install -g https://github.com/trgysvc/AgentRunlog/releases/download/v0.1.0/agentrunlog-0.1.0.tgz
```

### 2. Initialize in Your Project
Navigate to any coding repository and run:
```bash
runlog init
```
This automatically:
- Creates `.agentrunlog/` (`raw/`, `wiki/`, `cache/`, `config.json`).
- Adds `.agentrunlog/raw/` to `.gitignore` for privacy.
- Installs hook adapters for **Claude Code**, **Google Antigravity**, **Cursor**, and **Codex CLI**.

### 3. Connect MCP Server to Your Agent
Add `agentrunlog` to your agent's MCP configuration:

**Google Antigravity (`~/.gemini/config/mcp_config.json`) / Claude Code / Cursor:**
```json
{
  "mcpServers": {
    "agentrunlog": {
      "command": "runlog",
      "args": ["mcp"]
    }
  }
}
```

### 4. Useful CLI Commands
```bash
runlog status    # View active/superseded decisions, RCAs, and cache token budget
runlog compile   # Manually compile raw session transcripts into wiki pages
runlog lint      # Audit wiki for stale file references or broken supersedes links
runlog reindex   # Rebuild the entire wiki and cache from raw transcripts (NFR-10)
```

---

## 🗺️ Roadmap & Status

- [ ] **Core Engine**: Typed record schemas (`schema.md`), disk storage layout, and sanitization filter.
- [ ] **MCP Server**: Fast local MCP server providing `search`, `get_decision`, and `check_dead_ends`.
- [ ] **Capture Adapters**:
  - [ ] Claude Code hook adapter
  - [ ] Google Antigravity hook adapter
  - [ ] Cursor hook & rules adapter
  - [ ] Codex CLI hook adapter
- [ ] **Compiler Worker**: Background transcript parsing and typed wiki distillation.
- [ ] **Wiki Linter**: Conflict and staleness detection.

---

## 📄 License

MIT © [Turgay Savacı](https://github.com/trgysvc)
