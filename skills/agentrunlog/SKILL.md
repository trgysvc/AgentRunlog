---
name: agentrunlog
description: Manage and query persistent typed engineering memory across sessions (Decisions, RCAs, Dead Ends) using AgentRunlog MCP tools and CLI. Use when starting work in a project with .agentrunlog/, making architectural decisions, debugging recurring failures, or recording dead ends.
---

# AgentRunlog Engineering Memory Skill

AgentRunlog implements Andrej Karpathy's **LLM Wiki** pattern to maintain persistent, typed engineering memory across sessions.

> **IMPORTANT:** When calling any `agentrunlog` MCP tool, always pass `projectRoot` set to the active workspace's absolute path (e.g. `/path/to/MyProject`) so the tool reads and writes to the project's `.agentrunlog/` directory.

## When to Query Memory (Pull)
- **Session Start / New Feature**: Call `get_active_context` or `search_runlog` to review active architectural decisions and known pitfalls for the target module.
- **Before Risky Refactors or Library Choices**: Call `check_dead_ends` with your proposed approach to ensure you do not repeat previously failed attempts.
- **Debugging Recurring Errors**: Call `search_runlog(query: "<error keyword>", types: ["rca"])` to check if the root cause and fix were already documented.

## When to Record Memory (Write)
- **Decisions (`record_decision`)**: Whenever an explicit architecture, library, database, or pattern decision is made by the user or team. If it replaces an earlier choice, pass `supersedes: ["DEC-XXX"]`.
- **Dead Ends (`record_dead_end`)**: Only for structural/architectural incompatibilities (never transient network/syntax errors). Always specify explicit `retryConditions`.
- **Root Cause Analyses (`record_rca`)**: Whenever a non-trivial bug is diagnosed and fixed, recording the incident, root cause, and preventative resolution.

## Zero-Config Auto-Bootstrap
AgentRunlog automatically initializes `.agentrunlog/`, secures `.gitignore`, scans the codebase, and imports past agent conversations across all 4 platforms on the first hook or MCP call (`get_active_context`). Users never have to remember manual setup commands.
