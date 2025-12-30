/**
 * Parallel Execute Tool - Implementation
 */

import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"
import type { ParallelExecuteArgs } from "./types"
import { PARALLEL_EXECUTE_DESCRIPTION } from "./constants"
import {
  type Task,
  type DependencyMap,
  type ProgressEvent,
  buildDAG,
  getExecutionLevels,
  extractExplicitDependencies,
  ParallelExecutor,
  InferenceCache,
  shouldParallelize,
  analyzeParallelizationPotential,
  renderExecutionPlan,
  renderDependencyList,
  renderProgressBar,
  renderExecutionSummary,
  calculateCriticalPath,
  DEFAULT_EXECUTION_CONFIG,
} from "../../features/parallel-executor"
import { log } from "../../shared/logger"

type OpencodeClient = PluginInput["client"]

interface Todo {
  id: string
  content: string
  status: string
  priority: string
}

// Global inference cache
const inferenceCache = new InferenceCache()

/**
 * Create the parallel_execute tool
 */
export function createParallelExecuteTool(
  ctx: PluginInput,
  backgroundManager: BackgroundManager
): ToolDefinition {
  return tool({
    description: PARALLEL_EXECUTE_DESCRIPTION,
    args: {
      analyze_only: tool.schema.boolean().optional().describe("Just show execution plan without running"),
      max_concurrency: tool.schema.number().optional().describe("Maximum parallel tasks (default: 4)"),
      agent: tool.schema.string().optional().describe("Agent type for task execution"),
      fail_fast: tool.schema.boolean().optional().describe("Stop on first failure"),
      auto_skip: tool.schema.boolean().optional().describe("Skip if parallelization won't help (default: true)"),
    },
    async execute(args: ParallelExecuteArgs, toolContext) {
      const sessionID = toolContext.sessionID
      
      log("[parallel-execute] Starting", { sessionID, args })
      
      // 1. Fetch current todos
      let todos: Todo[]
      try {
        const response = await ctx.client.session.todo({
          path: { id: sessionID },
        })
        todos = (response.data ?? response) as Todo[]
      } catch (error) {
        return `❌ Failed to fetch todos: ${error instanceof Error ? error.message : String(error)}`
      }
      
      if (!todos || todos.length === 0) {
        return `ℹ️ No todos found in current session. Create todos first using todowrite.`
      }
      
      // Filter to pending/in_progress todos only
      const activeTodos = todos.filter(t => 
        t.status === "pending" || t.status === "in_progress"
      )
      
      if (activeTodos.length === 0) {
        return `✅ All todos are already completed or cancelled. Nothing to execute.`
      }
      
      if (activeTodos.length === 1) {
        return `ℹ️ Only 1 active todo found. Parallel execution not needed for single task. Execute it directly.`
      }
      
      // 2. Convert todos to Task format
      const tasks: Task[] = activeTodos.map(t => ({
        id: t.id,
        content: t.content,
        status: "pending" as const,
        priority: (t.priority as "high" | "medium" | "low") || "medium",
      }))
      
      // 3. Check cache for dependency inference
      let dependencyMap: DependencyMap
      let reasoning: Record<string, string> = {}
      let fromCache = false
      
      const cached = inferenceCache.get(tasks)
      if (cached) {
        dependencyMap = cached.dependencies
        reasoning = cached.reasoning
        fromCache = true
        log("[parallel-execute] Using cached dependencies")
      } else {
        // 4. Extract explicit dependencies from task content
        const explicitDeps = extractExplicitDependencies(tasks)
        
        // 5. Use explicit dependencies only (LLM inference disabled for now)
        // TODO: Re-enable LLM inference when we have a proper synchronous LLM API
        dependencyMap = explicitDeps
        
        // Generate basic reasoning from task content
        for (const task of tasks) {
          const deps = dependencyMap[task.id] || []
          if (deps.length > 0) {
            reasoning[task.id] = `Depends on: ${deps.join(", ")} (explicit)`
          } else {
            reasoning[task.id] = "No dependencies detected"
          }
        }
        
        // Cache the result
        inferenceCache.set(tasks, dependencyMap, reasoning, "medium")
        
        log("[parallel-execute] Using explicit dependencies", { 
          taskCount: tasks.length,
          dependencyCount: Object.values(dependencyMap).flat().length,
        })
      }
      
      // 6. Check if parallelization is worthwhile
      const autoSkip = args.auto_skip !== false
      if (autoSkip) {
        const assessment = shouldParallelize(tasks, dependencyMap)
        if (!assessment.shouldParallelize) {
          return `ℹ️ Parallelization Skipped\n\n${assessment.reason}\n\nExecute tasks sequentially for better efficiency.`
        }
      }
      
      // 7. Build DAG
      let dag
      try {
        dag = buildDAG(tasks, dependencyMap)
      } catch (error) {
        return `❌ Failed to build dependency graph: ${error instanceof Error ? error.message : String(error)}`
      }
      
      const levels = getExecutionLevels(dag)
      
      // 8. Calculate critical path for optimization
      const taskDurations = new Map<string, number>()
      for (const task of tasks) {
        taskDurations.set(task.id, task.estimatedDuration || 30)
      }
      const criticalPath = calculateCriticalPath(dag, taskDurations)
      
      // 9. Generate execution plan
      const plan = renderExecutionPlan(dag, criticalPath)
      const depList = renderDependencyList(dag, reasoning)
      
      // If analyze_only, return the plan
      if (args.analyze_only) {
        const analysis = analyzeParallelizationPotential(tasks, dependencyMap)
        
        return `# Parallel Execution Analysis

${plan}

${depList}

## Assessment
${analysis.assessment.reason}
${analysis.recommendations.length > 0 ? `\n### Recommendations\n${analysis.recommendations.map(r => `- ${r}`).join("\n")}` : ""}

${fromCache ? "_Using cached dependency analysis_" : "_Fresh dependency analysis_"}`
      }
      
      // 10. Execute in parallel
      const executor = new ParallelExecutor(ctx, backgroundManager, {
        maxConcurrency: args.max_concurrency || DEFAULT_EXECUTION_CONFIG.maxConcurrency,
        failFast: args.fail_fast || false,
        defaultAgent: args.agent || "general",
        parentSessionID: toolContext.sessionID,
        parentMessageID: toolContext.messageID,
      })
      
      // Track progress
      const progressMessages: string[] = []
      executor.setProgressCallback(async (event: ProgressEvent) => {
        const progress = renderProgressBar(event.completed, event.total, event.failed, event.blocked)
        progressMessages.push(`[${event.type}] ${progress} - ${event.message || ""}`)
        
        // Show toast for significant events
        if (event.type === "level_complete" || event.type === "task_failed") {
          await ctx.client.tui?.showToast?.({
            body: {
              title: "Parallel Execution",
              message: event.message || `${event.completed}/${event.total} completed`,
              variant: event.type === "task_failed" ? "error" : "info",
              duration: 3000,
            },
          }).catch(() => {})
        }
      })
      
      // Execute
      const result = await executor.execute(tasks, dependencyMap)
      
      // 11. Generate summary
      const summary = renderExecutionSummary(
        result.stats,
        result.totalDurationMs,
        result.efficiency?.speedupFactor || 1
      )
      
      // NOTE: Todo statuses are managed by the calling agent through todowrite tool
      // The parallel executor just reports results; the agent will update todos accordingly
      
      // Build result message
      let resultMessage = `# Parallel Execution Complete

${summary}

${plan}

## Execution Log
\`\`\`
${progressMessages.slice(-20).join("\n")}
\`\`\``

      // Add failure details if any
      if (result.stats.failed > 0) {
        const failures: string[] = []
        for (const [taskId, taskResult] of result.taskResults) {
          if (taskResult.status === "failed") {
            const task = tasks.find(t => t.id === taskId)
            failures.push(`- [${taskId}] ${task?.content.slice(0, 50)}...\n  Error: ${taskResult.error}`)
          }
        }
        resultMessage += `\n\n## Failed Tasks\n${failures.join("\n")}`
      }
      
      if (result.cascadeBlocked.length > 0) {
        resultMessage += `\n\n## Blocked Tasks (${result.cascadeBlocked.length})\nThese tasks were blocked due to upstream failures: ${result.cascadeBlocked.join(", ")}`
      }
      
      return resultMessage
    },
  })
}
