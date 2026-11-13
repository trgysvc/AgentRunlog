# AgentRunlog — Platform Usage Guide

How to use AgentRunlog with each supported coding agent. Everything is deterministic: no model is ever called, nothing leaves your machine.

## 0. Common to every platform

### Install and verify
```bash
npm install -g git+https://github.com/trgysvc/AgentRunlog.git   # postinstall configures all 4 platforms
runlog doctor                                                    # checks plugins, hooks and a live MCP handshake
runlog init [claude|cursor|codex|antigravity]                    # optional: first scan (+ project hooks only where the global install has none)
```
Open a project in any agent and start working. On the first hook or MCP call AgentRunlog creates `.agentrunlog/`, adds `raw/` to `.gitignore`, scans the codebase and imports past conversations in the background. You never run anything by hand.

The installer registers the MCP server as `bundle/agentrunlog.mjs` (self-contained, no `node_modules`) and hooks as `bundle/hook.mjs`. If a platform still points at an older `dist/cli/index.js` entry, run `runlog setup` (or `runlog install-plugin <platform>`) again. `runlog doctor` shows which entry is used. Restart the agent after re-installing: running sessions read their MCP list at start.

### Where hooks are registered (one place only)
Per the current official docs, Claude Code, Cursor and Codex **merge user-level and project-level hooks and run all of them**; Antigravity loads global, workspace and plugin hook files side by side. Registering AgentRunlog in two places therefore fires every event twice. The global install (`runlog setup`) registers the hooks once at user level; `runlog init` writes project hooks **only for platforms that have no user-level AgentRunlog hooks** and removes older project copies otherwise. Re-running the installer is idempotent (it replaces its own entries and keeps yours). Antigravity additionally drops an identical event that arrives twice within 0.5 s.

Hook sets (only events AgentRunlog uses; it never registers permission hooks such as `PreToolUse`, because empty output on a permission hook can block the tool):
- Claude Code: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `SessionEnd`.
- Cursor: `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, `preCompact`, `stop`.
- Codex: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop`.
- Antigravity: `SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, `Stop`.

### What happens automatically
| When | What AgentRunlog does |
|---|---|
| Every prompt / tool run / error | Appends a redacted event to `.agentrunlog/raw/session-<id>.jsonl` (secrets stripped before disk). |
| Session start | Injects (≤ 800 tokens): active decisions, known dead ends, recent RCAs, a handoff of the last session (open work), and the latest verified test/build/lint commands. |
| 25 uncompiled turns, `PreCompact`, `SessionEnd`, or next session start | Background compile → wiki (`decisions`, `rca`, `dead-ends`, `tasks`, `runs`, journey pages) + caches. **Never depends on `SessionEnd`.** |
| Same command fails twice in one session | Injects the matching RCA / dead end as an advisory (never blocks). Delivery differs per platform, see below. |

### Commands you may want
```bash
runlog status    # records, token budget          runlog usage   # disk usage per folder
runlog report    # impact: injections, repeated failures, unverified claims, stale records
runlog lint      # stale file refs, broken supersedes, missing retry conditions
runlog llm-review enable|disable|status   # opt-in: your agent's LLM reviews decision conflicts (spends tokens, off by default)
runlog pause     # stop recording in this project (runlog resume to continue)
runlog reindex   # rebuild wiki from raw/ (explicit MCP records are replayed from a journal)
runlog scan --force   # re-import every past conversation
```

### MCP tools the agent can call
`search_runlog`, `get_decision`, `get_rca`, `check_dead_ends`, `get_active_context`, and the live writers `record_decision`, `record_dead_end`, `record_rca`. Decisions saved through `record_decision` are active immediately; decisions guessed from prompt keywords stay `draft` and are never pushed.

### Optional: LLM decision-conflict review (off by default)
Works the same on all four platforms because it rides on the normal push + MCP. Enabling it (`runlog llm-review enable`) means your agent's model spends extra tokens each session; you confirm this once. Details in the README.

Limitation: only decisions sharing a module (`affectsModules`) are compared; decisions without modules are never reviewed. Broader candidate selection (e.g. title similarity) is planned and would raise token spending and false alarms; it will stay opt-in.

### Privacy controls
`.agentrunlog/config.json` → `privacy.enabled: false` (record nothing) and `privacy.excludePatterns` (globs matched against paths and commands). `runlog pause` is the quick toggle. Your platforms' original conversation stores are only ever read, never modified.

---

## 1. Claude Code

**Setup:** `runlog init claude` writes hooks into `.claude/settings.json`, registers the MCP server in `.mcp.json` and pre-approves it (`enabledMcpjsonServers`), so no approval prompt appears. The global install covers `~/.claude.json` and `~/.claude/settings.json`.

**Hooks used:** `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `SessionEnd`.

**Push:** `SessionStart` stdout is added to the model's context.

**Repeated-failure guard:** `PostToolUseFailure` → `hookSpecificOutput.additionalContext`, delivered right after the second identical failure. Verified end to end with a real Claude Code session.

**Notes**
- `claude -p` fires `SessionEnd` on every call; that is why compile triggers must not rely on it. They don't.
- `/compact` triggers a compile (`PreCompact`).
- If MCP tools are missing in a fresh project, run `runlog init claude` again.

---

## 2. Cursor (IDE and CLI)

**Setup:** `runlog init cursor` writes `.cursor/hooks.json` and the rule `.cursor/rules/agentrunlog.mdc`. Global: `~/.cursor/hooks.json`, `~/.cursor/mcp.json`, `~/.cursor/rules/agentrunlog.mdc`.

**Hooks used:** `sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `postToolUseFailure`, `preCompact`, `stop`. `preToolUse` is deliberately not registered: per the docs it is a permission hook and an invalid or empty response can block the tool.

**Push:** `sessionStart` returns `additional_context`. Cursor's forum has reports that `sessionStart` context is not always surfaced to the model, so the always-on rule file instructs the agent to call `get_active_context` / `check_dead_ends` over MCP as a fallback.

**Repeated-failure guard:** `postToolUseFailure` (`error_message`) → `additional_context`. Cursor fires `postToolUse` only on success, which is why the failure hook is registered separately. There are forum reports that `additional_context` from `postToolUse` is not delivered for non-MCP tools; we rely only on the documented failure event.

**Notes:** hook output must be valid JSON; exit code 2 would block, so AgentRunlog always exits 0.

---

## 3. Codex CLI

**Setup:** `runlog init codex` writes `.codex/hooks.json`; the global install writes `~/.codex/hooks.json`, `features.hooks = true` in `~/.codex/config.toml`, MCP config and `AGENTS.md`.

**Trust step (required once):** Codex skips hooks that are new or changed until you review them. Open `/hooks` in the Codex CLI and trust the AgentRunlog hooks. After an AgentRunlog upgrade that changes the hook command, trust them again.

**Hooks used:** `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PreCompact`, `Stop`. `PreToolUse` is not registered (permission hook, AgentRunlog never gates tools).

**Push:** `SessionStart` output.

**Repeated-failure guard:** `PostToolUse` also runs after non-zero Bash exits. The hook payload has no dedicated exit-code field, so AgentRunlog looks for an exit code inside `tool_response` and falls back to text such as "exited with code 1". The advisory is returned as `hookSpecificOutput.additionalContext` (added as developer context). Plain stdout is ignored by Codex, which is why JSON is used.

**Notes:** output above ~2,500 tokens is spilled to disk by Codex; the guard text is tiny. Tool hooks are a guardrail, not an enforcement boundary — AgentRunlog only advises.

---

## 4. Google Antigravity (IDE and CLI)

**Setup:** `runlog init antigravity` writes the `agentrunlog` group into `.agents/hooks.json`; the global install creates the plugin under `~/.gemini/config/plugins/agentrunlog/` with MCP, hooks, `rules/AGENTS.md` and a skill. In the CLI `/hooks` lists active hooks; in the IDE and app use Customizations > Hooks.

**Installing on a fresh machine (step by step)**
1. Requirements: Node.js 20+, git, and Antigravity installed and started at least once (so `~/.gemini/` exists).
2. `npm install -g git+https://github.com/trgysvc/AgentRunlog.git` (postinstall runs the setup for all platforms). If the global install is not wanted: clone the repo, `npm install && npm test` (this builds `bundle/`), then `node bundle/agentrunlog.mjs setup`.
3. `runlog doctor`: the Antigravity line must be ✅ (plugin, hooks, MCP handshake with all 9 tools). If it is ❌, run `runlog install-plugin antigravity` and check again.
4. In your project: `runlog init antigravity` (project-level `.agents/hooks.json`, first scan).
5. **Fully restart Antigravity**, open the project, and check the hooks list (CLI: `/hooks`; IDE/app: Customizations > Hooks): the `agentrunlog` group must be listed once. Check the MCP list for `agentrunlog`.
6. Work for a few prompts, then run `runlog report` (or look at `.agentrunlog/raw/`) to confirm events are being captured. After 25 turns, or at the next session start, the wiki compiles on its own.
7. If something does not fire, send the output of `runlog doctor`, `.agentrunlog/raw/` file names and the Antigravity version; that is the information needed for the test report.

**Hooks used:** `SessionStart`, `PreInvocation`, `PostInvocation`, `PostToolUse`, `Stop`. `PreToolUse` is deliberately not registered: it must return a permission decision and AgentRunlog never gates tools.

**Push:** `SessionStart` → `injectSteps` system message.

**Repeated-failure guard:** Antigravity's `PostToolUse` output must be `{}`; the docs define no injection there. AgentRunlog therefore stores the advisory in `cache/pending_guard.json` and delivers it once at the next `PreInvocation` via `injectSteps`. It reaches the agent before its next model call, not instantly after the failing tool.

**Notes**
- The Antigravity CLI does not load hooks from `~/.gemini/antigravity-cli/settings.json`; use `.agents/hooks.json` or `~/.gemini/config/hooks.json`.
- The Antigravity IDE has had a user report of `Stop`/`PostToolUse` hooks not firing on some Windows builds; capture then relies on the other events and on the history import.
- Hook timeout is 10 s in our manifest; the hook itself takes ~30 ms.

---

## 5. Troubleshooting
| Symptom | Fix |
|---|---|
| Nothing is injected | `runlog doctor`; confirm the project has `.agentrunlog/cache/active_context.json` (`runlog compile` or keep working: the first 25 turns/PreCompact/next start will compile). |
| Nothing is recorded | `runlog resume`; check `privacy.enabled` and `excludePatterns`; see `.agentrunlog/cache/hook-errors.log`. |
| Codex hooks silent | Trust them in `/hooks`. |
| Wiki looks wrong/stale | `runlog reindex` (backs up the old wiki first). |
| Disk usage | `runlog usage`. |
