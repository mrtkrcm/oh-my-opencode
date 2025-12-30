/**
 * Parallel Execution Engine
 * 
 * Executes tasks in parallel based on dependency graph levels.
 * Handles:
 * - Phase 1: Basic parallel execution
 * - Phase 2: Retry logic, cascade blocking, progress callbacks
 * - Phase 3: Critical path optimization, dynamic replanning
 */

import type { PluginInput } from "@opencode-ai/plugin"
import type {
  Task,
  TaskId,
  TaskResult,
  DAG,
  ExecutionLevel,
  ExecutionConfig,
  ExecutionResult,
  ExecutionStats,
  EfficiencyMetrics,
  ProgressEvent,
  ProgressCallback,
  CriticalPathInfo,
  ReplanDecision,
} from "./types"
import { DEFAULT_EXECUTION_CONFIG, ExecutionTimeoutError } from "./types"
import {
  buildDAG,
  getExecutionLevels,
  markTaskCompleted,
  markTaskFailed,
  calculateParallelizationMetrics,
} from "./dag"
import type { BackgroundManager } from "../background-agent"

type OpencodeClient = PluginInput["client"]

/**
 * Main execution engine for parallel task execution
 */
export class ParallelExecutor {
  private client: OpencodeClient
  private backgroundManager: BackgroundManager
  private directory: string
  private config: ExecutionConfig
  private progressCallback?: ProgressCallback
  
  // Execution state
  private dag: DAG | null = null
  private taskResults: Map<TaskId, TaskResult> = new Map()
  private runningTasks: Map<TaskId, { sessionId: string; startTime: number }> = new Map()
  private retryCount: Map<TaskId, number> = new Map()
  
  constructor(
    ctx: PluginInput,
    backgroundManager: BackgroundManager,
    config: Partial<ExecutionConfig> = {}
  ) {
    this.client = ctx.client
    this.directory = ctx.directory
    this.backgroundManager = backgroundManager
    this.config = { ...DEFAULT_EXECUTION_CONFIG, ...config }
  }
  
  /**
   * Set progress callback for execution updates
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback
  }
  
  /**
   * Execute tasks in parallel based on dependencies
   */
  async execute(
    tasks: Task[],
    dependencyMap: Record<TaskId, TaskId[]>
  ): Promise<ExecutionResult> {
    const startTime = Date.now()
    
    // Reset state
    this.taskResults.clear()
    this.runningTasks.clear()
    this.retryCount.clear()
    
    // Build DAG
    this.dag = buildDAG(tasks, dependencyMap)
    const levels = getExecutionLevels(this.dag)
    
    // Emit start event
    await this.emitProgress({
      type: "execution_start",
      timestamp: new Date(),
      completed: 0,
      total: tasks.length,
      failed: 0,
      blocked: 0,
      message: `Starting parallel execution of ${tasks.length} tasks in ${levels.length} levels`,
    })
    
    // Execute levels sequentially, tasks within levels in parallel
    for (const level of levels) {
      await this.executeLevel(level)
      
      // Check fail-fast
      if (this.config.failFast && this.hasFailures()) {
        break
      }
      
      // Check total timeout
      if (this.config.totalTimeoutMs && Date.now() - startTime > this.config.totalTimeoutMs) {
        break
      }
    }
    
    // Build result
    const result = this.buildExecutionResult(tasks, startTime)
    
    // Emit completion event
    await this.emitProgress({
      type: "execution_complete",
      timestamp: new Date(),
      completed: result.stats.completed,
      total: result.stats.total,
      failed: result.stats.failed,
      blocked: result.stats.cascadeBlocked,
      message: `Execution complete: ${result.stats.completed}/${result.stats.total} succeeded`,
    })
    
    return result
  }
  
  /**
   * Execute a single level (all tasks in parallel)
   */
  private async executeLevel(level: ExecutionLevel): Promise<void> {
    // Filter out blocked tasks
    const executableTasks = level.tasks.filter(task => {
      const node = this.dag?.nodes.get(task.id)
      return node && node.status !== "cascade_blocked" && node.status !== "failed"
    })
    
    if (executableTasks.length === 0) {
      return
    }
    
    await this.emitProgress({
      type: "level_start",
      timestamp: new Date(),
      level: level.level,
      completed: this.countCompleted(),
      total: this.dag?.nodes.size ?? 0,
      failed: this.countFailed(),
      blocked: this.countBlocked(),
      message: `Starting level ${level.level} with ${executableTasks.length} tasks`,
    })
    
    // Execute tasks in batches respecting concurrency limit
    const batches = this.createBatches(executableTasks, this.config.maxConcurrency)
    
    for (const batch of batches) {
      await this.executeBatch(batch)
    }
    
    await this.emitProgress({
      type: "level_complete",
      timestamp: new Date(),
      level: level.level,
      completed: this.countCompleted(),
      total: this.dag?.nodes.size ?? 0,
      failed: this.countFailed(),
      blocked: this.countBlocked(),
      message: `Level ${level.level} complete`,
    })
  }
  
  /**
   * Execute a batch of tasks in parallel
   */
  private async executeBatch(tasks: Task[]): Promise<void> {
    const promises = tasks.map(task => this.executeTask(task))
    const results = await Promise.allSettled(promises)
    
    // Process results
    for (let i = 0; i < results.length; i++) {
      const task = tasks[i]
      const result = results[i]
      
      if (result.status === "fulfilled") {
        this.taskResults.set(task.id, result.value)
        
        if (result.value.status === "completed") {
          markTaskCompleted(this.dag!, task.id)
        } else {
          const blocked = markTaskFailed(this.dag!, task.id)
          await this.emitCascadeBlock(task.id, blocked)
        }
      } else {
        // Promise rejected - create error result
        const errorResult: TaskResult = {
          taskId: task.id,
          status: "failed",
          error: result.reason?.message || String(result.reason),
          durationMs: 0,
          retryCount: this.retryCount.get(task.id) || 0,
        }
        this.taskResults.set(task.id, errorResult)
        
        const blocked = markTaskFailed(this.dag!, task.id)
        await this.emitCascadeBlock(task.id, blocked)
      }
    }
  }
  
  /**
   * Execute a single task with retry logic
   */
  private async executeTask(task: Task): Promise<TaskResult> {
    const startTime = Date.now()
    let lastError: string | undefined
    
    const maxRetries = this.config.retryCount
    let attempt = 0
    
    while (attempt <= maxRetries) {
      try {
        await this.emitProgress({
          type: attempt === 0 ? "task_start" : "task_retry",
          timestamp: new Date(),
          taskId: task.id,
          taskContent: task.content,
          completed: this.countCompleted(),
          total: this.dag?.nodes.size ?? 0,
          failed: this.countFailed(),
          blocked: this.countBlocked(),
          message: attempt === 0 
            ? `Starting task: ${task.content.slice(0, 50)}...`
            : `Retrying task (attempt ${attempt + 1}/${maxRetries + 1}): ${task.content.slice(0, 50)}...`,
        })
        
        // Execute via background task
        const result = await this.executeTaskViaAgent(task)
        
        if (result.status === "completed") {
          await this.emitProgress({
            type: "task_complete",
            timestamp: new Date(),
            taskId: task.id,
            taskContent: task.content,
            completed: this.countCompleted() + 1,
            total: this.dag?.nodes.size ?? 0,
            failed: this.countFailed(),
            blocked: this.countBlocked(),
            message: `Task completed: ${task.content.slice(0, 50)}...`,
          })
          
          return result
        }
        
        lastError = result.error
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      
      // Retry with backoff
      if (attempt < maxRetries) {
        const delay = this.config.retryDelayMs * Math.pow(this.config.retryBackoffMultiplier, attempt)
        await this.sleep(delay)
      }
      
      attempt++
      this.retryCount.set(task.id, attempt)
    }
    
    // All retries exhausted
    const failedResult: TaskResult = {
      taskId: task.id,
      status: "failed",
      error: lastError || "Unknown error",
      durationMs: Date.now() - startTime,
      retryCount: attempt,
    }
    
    await this.emitProgress({
      type: "task_failed",
      timestamp: new Date(),
      taskId: task.id,
      taskContent: task.content,
      completed: this.countCompleted(),
      total: this.dag?.nodes.size ?? 0,
      failed: this.countFailed() + 1,
      blocked: this.countBlocked(),
      message: `Task failed after ${attempt} attempts: ${lastError}`,
    })
    
    return failedResult
  }
  
  /**
   * Execute task using the background agent system
   */
  private async executeTaskViaAgent(task: Task): Promise<TaskResult> {
    const startTime = Date.now()
    
    // Build task prompt
    const prompt = this.buildTaskPrompt(task)
    
    // Launch via background manager
    const bgTask = await this.backgroundManager.launch({
      description: task.content.slice(0, 100),
      prompt,
      agent: this.config.defaultAgent,
      parentSessionID: this.config.parentSessionID || "",
      parentMessageID: this.config.parentMessageID || "",
    })
    
    this.runningTasks.set(task.id, {
      sessionId: bgTask.sessionID,
      startTime,
    })
    
    // Wait for completion with timeout
    const result = await this.waitForTaskCompletion(
      task.id,
      bgTask.id,
      this.config.taskTimeoutMs
    )
    
    this.runningTasks.delete(task.id)
    
    return result
  }
  
  /**
   * Build prompt for task execution
   */
  private buildTaskPrompt(task: Task): string {
    // Get context from completed dependency results
    const dependencyContext = this.getDependencyContext(task.id)
    
    return `Execute the following task:

## Task
${task.content}

## Priority
${task.priority}

${dependencyContext ? `## Context from Completed Dependencies\n${dependencyContext}\n` : ""}

## Instructions
- Complete the task as described
- Report any issues or blockers
- Provide a summary of what was accomplished`
  }
  
  /**
   * Get context from completed dependency tasks
   */
  private getDependencyContext(taskId: TaskId): string | null {
    if (!this.dag) return null
    
    const node = this.dag.nodes.get(taskId)
    if (!node) return null
    
    const contexts: string[] = []
    
    for (const depId of node.dependencies) {
      const depResult = this.taskResults.get(depId)
      if (depResult && depResult.status === "completed" && depResult.output) {
        contexts.push(`- [${depId}]: ${String(depResult.output).slice(0, 500)}`)
      }
    }
    
    return contexts.length > 0 ? contexts.join("\n") : null
  }
  
  /**
   * Wait for a background task to complete
   */
  private async waitForTaskCompletion(
    taskId: TaskId,
    bgTaskId: string,
    timeoutMs: number
  ): Promise<TaskResult> {
    const startTime = Date.now()
    
    while (Date.now() - startTime < timeoutMs) {
      const bgTask = this.backgroundManager.getTask(bgTaskId)
      
      if (!bgTask) {
        return {
          taskId,
          status: "failed",
          error: "Background task was deleted",
          durationMs: Date.now() - startTime,
          retryCount: this.retryCount.get(taskId) || 0,
        }
      }
      
      if (bgTask.status === "completed") {
        return {
          taskId,
          status: "completed",
          output: bgTask.result,
          durationMs: Date.now() - startTime,
          retryCount: this.retryCount.get(taskId) || 0,
          agentUsed: bgTask.agent,
        }
      }
      
      if (bgTask.status === "error" || bgTask.status === "cancelled") {
        return {
          taskId,
          status: "failed",
          error: bgTask.error || "Task failed",
          durationMs: Date.now() - startTime,
          retryCount: this.retryCount.get(taskId) || 0,
        }
      }
      
      // Poll every second
      await this.sleep(1000)
    }
    
    // Timeout
    throw new ExecutionTimeoutError(
      `Task ${taskId} timed out after ${timeoutMs}ms`,
      taskId,
      timeoutMs
    )
  }
  
  /**
   * Create batches of tasks respecting concurrency limit
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize))
    }
    return batches
  }
  
  /**
   * Build final execution result
   */
  private buildExecutionResult(tasks: Task[], startTime: number): ExecutionResult {
    const stats: ExecutionStats = {
      total: tasks.length,
      completed: this.countCompleted(),
      failed: this.countFailed(),
      cascadeBlocked: this.countBlocked(),
      cancelled: 0,
      retried: Array.from(this.retryCount.values()).filter(c => c > 0).length,
    }
    
    const cascadeBlocked: TaskId[] = []
    for (const [taskId, node] of this.dag?.nodes ?? []) {
      if (node.status === "cascade_blocked") {
        cascadeBlocked.push(taskId)
      }
    }
    
    const totalDurationMs = Date.now() - startTime
    
    // Calculate efficiency metrics
    const efficiency = this.calculateEfficiency(totalDurationMs)
    
    // Determine overall status
    let status: "success" | "partial_success" | "failed"
    if (stats.failed === 0 && stats.cascadeBlocked === 0) {
      status = "success"
    } else if (stats.completed > 0) {
      status = "partial_success"
    } else {
      status = "failed"
    }
    
    return {
      status,
      taskResults: this.taskResults,
      stats,
      cascadeBlocked,
      totalDurationMs,
      efficiency,
    }
  }
  
  /**
   * Calculate efficiency metrics
   */
  private calculateEfficiency(actualDurationMs: number): EfficiencyMetrics {
    // Sum up all task durations
    let theoreticalSequentialMs = 0
    for (const result of this.taskResults.values()) {
      theoreticalSequentialMs += result.durationMs
    }
    
    const speedupFactor = theoreticalSequentialMs > 0
      ? theoreticalSequentialMs / actualDurationMs
      : 1
    
    const metrics = this.dag 
      ? calculateParallelizationMetrics(this.dag)
      : { maxParallelism: 1, avgParallelism: 1 }
    
    return {
      actualDurationMs,
      theoreticalSequentialMs,
      speedupFactor,
      avgParallelism: metrics.avgParallelism,
      maxParallelism: metrics.maxParallelism,
    }
  }
  
  /**
   * Emit cascade block events
   */
  private async emitCascadeBlock(failedTaskId: TaskId, blockedIds: TaskId[]): Promise<void> {
    if (blockedIds.length === 0) return
    
    await this.emitProgress({
      type: "cascade_block",
      timestamp: new Date(),
      taskId: failedTaskId,
      completed: this.countCompleted(),
      total: this.dag?.nodes.size ?? 0,
      failed: this.countFailed(),
      blocked: this.countBlocked(),
      message: `Task ${failedTaskId} failed, blocking ${blockedIds.length} dependent tasks: ${blockedIds.join(", ")}`,
    })
  }
  
  /**
   * Emit progress event
   */
  private async emitProgress(event: ProgressEvent): Promise<void> {
    if (this.progressCallback) {
      try {
        await this.progressCallback(event)
      } catch {
        // Ignore callback errors
      }
    }
  }
  
  // Helper methods
  private hasFailures(): boolean {
    for (const result of this.taskResults.values()) {
      if (result.status === "failed") return true
    }
    return false
  }
  
  private countCompleted(): number {
    let count = 0
    for (const result of this.taskResults.values()) {
      if (result.status === "completed") count++
    }
    return count
  }
  
  private countFailed(): number {
    let count = 0
    for (const result of this.taskResults.values()) {
      if (result.status === "failed") count++
    }
    return count
  }
  
  private countBlocked(): number {
    if (!this.dag) return 0
    let count = 0
    for (const node of this.dag.nodes.values()) {
      if (node.status === "cascade_blocked") count++
    }
    return count
  }
  
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}

// ============================================================================
// PHASE 3: CRITICAL PATH OPTIMIZATION
// ============================================================================

/**
 * Calculate critical path through the DAG
 * Uses forward and backward pass algorithm
 */
export function calculateCriticalPath(
  dag: DAG,
  taskDurations: Map<TaskId, number>
): CriticalPathInfo {
  const earliestStart = new Map<TaskId, number>()
  const earliestFinish = new Map<TaskId, number>()
  const latestStart = new Map<TaskId, number>()
  const latestFinish = new Map<TaskId, number>()
  
  // Get topological order
  const order = dag.topologicalOrder
  
  // Forward pass - calculate earliest times
  for (const taskId of order) {
    const node = dag.nodes.get(taskId)!
    const duration = taskDurations.get(taskId) || 1
    
    let es = 0
    for (const depId of node.dependencies) {
      es = Math.max(es, earliestFinish.get(depId) || 0)
    }
    
    earliestStart.set(taskId, es)
    earliestFinish.set(taskId, es + duration)
  }
  
  // Find project end time
  const projectDuration = Math.max(...earliestFinish.values(), 0)
  
  // Backward pass - calculate latest times
  const reversedOrder = [...order].reverse()
  
  for (const taskId of reversedOrder) {
    const node = dag.nodes.get(taskId)!
    const duration = taskDurations.get(taskId) || 1
    
    let lf = projectDuration
    for (const dependentId of node.dependents) {
      lf = Math.min(lf, latestStart.get(dependentId) || projectDuration)
    }
    
    latestFinish.set(taskId, lf)
    latestStart.set(taskId, lf - duration)
  }
  
  // Calculate slack and identify critical path
  const slackByTask = new Map<TaskId, number>()
  const criticalPath: TaskId[] = []
  
  for (const taskId of order) {
    const slack = (latestStart.get(taskId) || 0) - (earliestStart.get(taskId) || 0)
    slackByTask.set(taskId, slack)
    
    if (slack === 0) {
      criticalPath.push(taskId)
    }
  }
  
  return {
    criticalPath,
    projectDuration,
    slackByTask,
    earliestStart,
    latestStart,
  }
}

/**
 * Prioritize tasks based on critical path
 * Returns tasks sorted by priority (critical path first, then by slack)
 */
export function prioritizeByCriticalPath(
  tasks: Task[],
  criticalPathInfo: CriticalPathInfo
): Task[] {
  const criticalSet = new Set(criticalPathInfo.criticalPath)
  
  return [...tasks].sort((a, b) => {
    // Critical path tasks first
    const aIsCritical = criticalSet.has(a.id)
    const bIsCritical = criticalSet.has(b.id)
    
    if (aIsCritical && !bIsCritical) return -1
    if (!aIsCritical && bIsCritical) return 1
    
    // Then by slack (lower slack = higher priority)
    const aSlack = criticalPathInfo.slackByTask.get(a.id) || 0
    const bSlack = criticalPathInfo.slackByTask.get(b.id) || 0
    
    return aSlack - bSlack
  })
}
