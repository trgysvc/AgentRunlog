# AgentRunlog Engineering Memory Rules

You have access to the **AgentRunlog** typed engineering memory system via MCP (`agentrunlog`).
AgentRunlog **auto-initializes and scans any project automatically** on the first turn or MCP call — you do NOT need to ask the user to run CLI commands.

**IMPORTANT:** Always pass `projectRoot: "<active workspace absolute path>"` when calling any `agentrunlog` MCP tool so it targets the active repository instead of the plugin install directory.

1. **Check Before Acting (Prevent Repeated Mistakes):**
   - Before attempting major architectural changes, adding dependencies, or debugging recurring errors, check memory using `get_active_context`, `search_runlog`, or `check_dead_ends`.
   - If `check_dead_ends` flags a warning, read its `retryConditions` carefully. Never hard-block valid solutions if conditions have changed, but avoid repeating identical failing approaches.

2. **Autonomously Record Key Engineering Events (Zero User Prompt Needed):**
   - **Do NOT wait for the user to say "save this" or "remember this".** Proactively detect and silently record engineering knowledge during normal conversation:
     - When the user states or confirms an architectural/library/pattern choice (e.g. "Let's use X instead of Y"), silently call `record_decision` (passing `supersedes` if it replaces an older decision).
     - When an approach fundamentally fails due to a structural incompatibility, silently call `record_dead_end` with clear `retryConditions`.
     - When you diagnose and fix a non-trivial bug, silently call `record_rca` documenting the root cause and fix.

3. **Respect Privacy:**
   - Never intentionally store plaintext passwords, API keys, or tokens in decision or RCA descriptions.
