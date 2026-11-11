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

## 🤖 Dual-Agent Design & Zero-Cost Offline Compiler

AgentRunlog makes an intentional architectural distinction between the **Working Agent** and the **Compiler Worker**:

- **Working Agent (Claude Code, Google Antigravity, Cursor, Codex):** The primary AI coding assistant actively conversing with you, reading files, and writing code.
- **Compiler Worker (FR-10, NFR-06):** An asynchronous background process that parses raw JSONL session logs to extract structured decisions, RCAs, and dead ends without polluting the working agent's context.

> [!IMPORTANT]
> **Why an Out-of-Band Compiler?**  
> Forcing the working agent to simultaneously code and summarize hundreds of lines of chat history causes context bloat and mental fatigue (the primary pitfall observed in tools like Cline / Roo-Code). AgentRunlog offloads compilation to the background.
>
> **Zero External LLM Cost (Offline Heuristic Compiler):**  
> All 4 supported coding platforms already run their own frontier LLMs. Requiring users to configure external cloud API keys (OpenAI, Anthropic) just for memory compilation creates unnecessary friction. Therefore, AgentRunlog ships with a **Zero-Cost Offline Heuristic Compiler**: even without external API keys or network access, running `runlog compile` uses deterministic pattern recognition to extract failing commands, tool crashes, and task summaries into typed engineering artifacts. External LLMs (OpenAI, Anthropic, Gemini, Ollama) can optionally be configured if desired.

---

## 🚀 Installation & Plugin Setup

AgentRunlog ships as a **Native Plugin Bundle** (containing `plugin.json`, `mcp_config.json`, `hooks.json`, `rules/`, and `skills/`).

### 1. Install CLI & Plugin Bundle Globally from GitHub
```bash
npm install -g git+https://github.com/trgysvc/AgentRunlog.git
```
*(Or download the release tarball directly from [GitHub Releases](https://github.com/trgysvc/AgentRunlog/releases))*

### 2. Add to Your Coding Platform

#### 🟣 Google Antigravity (Recommended — Native Plugin)
Install the full plugin bundle (MCP + Hooks + Rules + Skill) into Antigravity with one command:
```bash
runlog install-plugin antigravity
```
*(Or clone directly: `git clone https://github.com/trgysvc/AgentRunlog.git ~/.gemini/config/plugins/agentrunlog`)*  
Then toggle **AgentRunlog Memory** on in Antigravity's **Customizations → Plugins** tab.

#### 🟠 Claude Code
Inside any project, or as a plugin:
```bash
runlog init claude
```
And ensure `agentrunlog` is in your MCP config (`.mcp.json` is included in the repo).

#### 🔵 Cursor
```bash
runlog init cursor
```
Installs `.cursor/hooks.json` and `.cursorrules` (which instructs Cursor to query `search_runlog` and `check_dead_ends` before major refactors). Add `agentrunlog` (`command: "runlog"`, `args: ["mcp"]`) in Cursor Settings → MCP.

#### 🟢 Codex CLI
```bash
runlog init codex
```

---

## 🛠️ How to Use While Developing a Project (Daily Workflow)

Once installed, **AgentRunlog works automatically in the background** without slowing down your workflow:

### Step 1: Initialize Your Repository (One-Time)
Navigate to your project folder (e.g., `cd MyProject`) and run:
```bash
runlog init
```
This creates `.agentrunlog/` (`raw/`, `wiki/`, `cache/`), adds `.agentrunlog/raw/` to `.gitignore`, and installs project-level hooks.

### Step 2: Code Normally & Record Decisions Live
As you work with your AI agent, you can speak naturally:
- **Record a Decision:** *"We decided to use Drizzle ORM instead of Prisma for edge compatibility. Record this decision."*  
  → The agent calls `record_decision`, creating `DEC-001.md` and updating `wiki/index.md`.
- **Record a Dead End:** *"Prisma crashes in Edge Workers due to binary size limits. Note this as a dead end."*  
  → The agent calls `record_dead_end` with explicit retry conditions.
- **Automatic Failure Capture:** Whenever a command fails during tool execution, the hook silently captures the error (redacting any database passwords or API tokens) and `runlog compile` turns it into an **RCA** (`RCA-*.md`).

### Step 3: Next Session (Automatic Memory Recall)
When you open a new chat tomorrow or switch to another agent (e.g., from Claude Code to Antigravity):
- **Push:** On the first turn, the hook injects active decisions, recent RCAs, and dead ends (< 800 tokens, < 20ms).
- **Pull:** Ask the agent *"What do we know about the database error?"* or *"Check dead ends before modifying auth."* The agent queries `search_runlog` and `check_dead_ends` via MCP.

### Step 4: Maintenance & CLI Commands
```bash
runlog status    # View active/superseded decisions, RCAs, dead ends, and token budget
runlog compile   # Manually compile raw session transcripts into wiki pages
runlog lint      # Audit wiki for stale file paths, missing retry conditions, or broken links
runlog reindex   # Wipe wiki and rebuild from scratch from raw/ transcripts (NFR-10)
```

---

## 🗺️ Roadmap & Status

- [x] **Core Engine**: Typed record schemas (`schema.md`), disk storage layout, and sanitization filter.
- [x] **MCP Server**: Fast local MCP server providing `search_runlog`, `get_decision`, `get_rca`, `check_dead_ends`, and `get_active_context`.
- [x] **Capture Adapters**:
  - [x] Claude Code hook adapter
  - [x] Google Antigravity hook adapter
  - [x] Cursor hook & rules adapter
  - [x] Codex CLI hook adapter
- [x] **Compiler Worker**: Zero-cost offline heuristic & multi-LLM transcript parser, `active_context.json` cache, and `wiki/index.md` builder.
- [x] **Wiki Linter**: Conflict, broken supersede link, and staleness detection (`runlog lint` & `runlog reindex`).

---

## 📄 License

MIT © [Turgay Savacı](https://github.com/trgysvc)
