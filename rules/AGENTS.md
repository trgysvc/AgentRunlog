# AgentRunlog Engineering Memory Rules

You have access to the **AgentRunlog** typed engineering memory system via MCP (`agentrunlog`).
Follow these rules on every project where `.agentrunlog/` is initialized:

**IMPORTANT:** Always pass `projectRoot: "<active workspace absolute path>"` when calling any `agentrunlog` MCP tool so it targets the active repository instead of the plugin install directory.

1. **Check Before Acting (Prevent Repeated Mistakes):**
   - Before attempting major architectural changes, adding dependencies, or debugging recurring errors, check memory using `get_active_context`, `search_runlog`, or `check_dead_ends`.
   - If `check_dead_ends` flags a warning, read its `retryConditions` carefully. Never hard-block valid solutions if conditions have changed, but avoid repeating identical failing approaches.

2. **Record Key Engineering Events Live:**
   - When the user confirms an architectural or technology choice (e.g. "Let's use X instead of Y"), call `record_decision` immediately (passing `supersedes` if it replaces an older decision).
   - When you discover a structural incompatibility or an approach that fundamentally fails, call `record_dead_end` with clear `retryConditions`.
   - When you solve a complex bug or recurring failure, call `record_rca` documenting the root cause and fix.

3. **Respect Privacy:**
   - Never intentionally store plaintext passwords, API keys, or tokens in decision or RCA descriptions.
