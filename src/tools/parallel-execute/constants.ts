/**
 * Parallel Execute Tool - Constants
 */

export const PARALLEL_EXECUTE_DESCRIPTION = `Execute current session's todo list in parallel with automatic dependency inference.

This tool analyzes your todo list, infers dependencies between tasks using AI, and executes them in optimal parallel batches.

**How it works:**
1. Reads current todos from the session
2. Uses LLM to infer which tasks depend on others
3. Builds a dependency graph (DAG)
4. Groups tasks into parallel execution levels
5. Executes tasks level-by-level, with tasks in each level running simultaneously

**When to use:**
- You have 3+ todos that might have dependencies
- Tasks take 30+ seconds each
- You want to speed up execution by running independent tasks in parallel

**Parameters:**
- \`analyze_only\`: Just show the execution plan without running (default: false)
- \`max_concurrency\`: Override default parallel task limit (default: 4)
- \`agent\`: Agent type to use for execution (default: "general")
- \`fail_fast\`: Stop all execution on first failure (default: false)
- \`auto_skip\`: Skip parallelization if heuristics say it won't help (default: true)

**Example usage:**
\`\`\`
// Analyze the execution plan first
parallel_execute({ analyze_only: true })

// Execute with custom concurrency
parallel_execute({ max_concurrency: 6 })

// Use specific agent
parallel_execute({ agent: "build" })
\`\`\`

**Returns:**
- Execution plan showing task dependencies and levels
- Progress updates during execution
- Final summary with speedup metrics`
