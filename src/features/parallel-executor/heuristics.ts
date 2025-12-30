/**
 * Parallelization Heuristics
 * 
 * Phase 3: Determines whether parallel execution is beneficial
 * based on task characteristics and expected overhead.
 */

import type {
  Task,
  TaskId,
  DependencyMap,
  ParallelizationAssessment,
  HeuristicsConfig,
  ConfidenceLevel,
} from "./types"
import { DEFAULT_HEURISTICS_CONFIG } from "./types"
import { buildDAG, calculateParallelizationMetrics } from "./dag"

/**
 * Assess whether tasks should be parallelized
 */
export function shouldParallelize(
  tasks: Task[],
  dependencyMap: DependencyMap,
  config: Partial<HeuristicsConfig> = {}
): ParallelizationAssessment {
  const cfg = { ...DEFAULT_HEURISTICS_CONFIG, ...config }
  
  // Check minimum task count
  if (tasks.length < cfg.minTasks) {
    return {
      shouldParallelize: false,
      reason: `Too few tasks (${tasks.length} < ${cfg.minTasks}). Sequential execution recommended.`,
      confidence: "high",
    }
  }
  
  // Check if all tasks form a linear chain
  const isLinearChain = checkLinearChain(tasks, dependencyMap)
  if (isLinearChain) {
    return {
      shouldParallelize: false,
      reason: "Tasks form a linear chain with no parallelization opportunity.",
      confidence: "high",
    }
  }
  
  // Build DAG and analyze
  let dag
  try {
    dag = buildDAG(tasks, dependencyMap)
  } catch (error) {
    return {
      shouldParallelize: false,
      reason: `Cannot build dependency graph: ${error instanceof Error ? error.message : String(error)}`,
      confidence: "high",
    }
  }
  
  const metrics = calculateParallelizationMetrics(dag)
  
  // Check parallelizable ratio
  if (metrics.parallelizableRatio < cfg.minParallelizableRatio) {
    return {
      shouldParallelize: false,
      reason: `Low parallelization opportunity (${(metrics.parallelizableRatio * 100).toFixed(1)}% < ${(cfg.minParallelizableRatio * 100).toFixed(1)}%).`,
      confidence: "medium",
    }
  }
  
  // Estimate times
  const totalEstimatedTime = estimateTotalTime(tasks)
  const sequentialTime = totalEstimatedTime
  const parallelTime = estimateParallelTime(tasks, metrics, cfg)
  const overhead = cfg.fixedOverhead + (tasks.length * cfg.overheadPerTask)
  
  // Check minimum total time
  if (totalEstimatedTime < cfg.minTotalTime) {
    return {
      shouldParallelize: false,
      reason: `Total estimated time too short (${totalEstimatedTime}s < ${cfg.minTotalTime}s). Overhead would negate benefits.`,
      estimatedSpeedup: sequentialTime / (parallelTime + overhead),
      estimatedOverhead: overhead,
      confidence: "medium",
    }
  }
  
  // Calculate expected speedup
  const expectedSpeedup = sequentialTime / (parallelTime + overhead)
  
  // Calculate absolute time saved
  const timeSaved = sequentialTime - (parallelTime + overhead)
  
  // Minimum absolute time saved (10 seconds) - small savings aren't worth complexity
  const minAbsoluteTimeSaved = 10
  
  // Decision thresholds:
  // 1. Relative: at least 20% improvement (1.2x speedup)
  // 2. Absolute: at least 10 seconds saved
  const meetsRelativeThreshold = expectedSpeedup >= 1.2
  const meetsAbsoluteThreshold = timeSaved >= minAbsoluteTimeSaved
  
  if (!meetsRelativeThreshold) {
    return {
      shouldParallelize: false,
      reason: `Insufficient speedup (${expectedSpeedup.toFixed(2)}x < 1.2x). Overhead would negate benefits.`,
      estimatedSpeedup: expectedSpeedup,
      estimatedOverhead: overhead,
      confidence: "medium",
    }
  }
  
  if (!meetsAbsoluteThreshold) {
    return {
      shouldParallelize: false,
      reason: `Time saved too small (${timeSaved.toFixed(1)}s < ${minAbsoluteTimeSaved}s). Not worth the complexity.`,
      estimatedSpeedup: expectedSpeedup,
      estimatedOverhead: overhead,
      confidence: "medium",
    }
  }
  
  // Parallelization recommended
  return {
    shouldParallelize: true,
    reason: `Parallelization recommended. Expected ${expectedSpeedup.toFixed(2)}x speedup (saves ~${timeSaved.toFixed(0)}s) with ${metrics.maxParallelism} max parallel tasks.`,
    estimatedSpeedup: expectedSpeedup,
    estimatedOverhead: overhead,
    confidence: determineConfidence(expectedSpeedup, metrics.parallelizableRatio),
  }
}

/**
 * Check if tasks form a linear chain (no parallelism possible)
 */
function checkLinearChain(tasks: Task[], dependencyMap: DependencyMap): boolean {
  if (tasks.length <= 1) return true
  
  // Count tasks with no dependencies
  let rootCount = 0
  for (const task of tasks) {
    const deps = dependencyMap[task.id] || []
    if (deps.length === 0) {
      rootCount++
    }
  }
  
  // If more than one root, there's potential parallelism
  if (rootCount > 1) return false
  
  // Check if each task has exactly one dependent
  const dependentCount = new Map<TaskId, number>()
  for (const task of tasks) {
    dependentCount.set(task.id, 0)
  }
  
  for (const deps of Object.values(dependencyMap)) {
    for (const depId of deps) {
      dependentCount.set(depId, (dependentCount.get(depId) || 0) + 1)
    }
  }
  
  // Linear chain: each task has at most one dependent (except the last)
  let multiDependentCount = 0
  for (const count of dependentCount.values()) {
    if (count > 1) {
      multiDependentCount++
    }
  }
  
  return multiDependentCount === 0 && rootCount === 1
}

/**
 * Estimate total time for all tasks (sequential)
 */
function estimateTotalTime(tasks: Task[]): number {
  let total = 0
  for (const task of tasks) {
    // Use ?? to handle 0 correctly (|| treats 0 as falsy)
    // Use Math.max to handle negative values
    const duration = task.estimatedDuration ?? 30
    total += Math.max(0, duration)
  }
  return total
}

/**
 * Estimate parallel execution time
 * Considers both average parallelism and critical path bounds
 */
function estimateParallelTime(
  tasks: Task[],
  metrics: ReturnType<typeof calculateParallelizationMetrics>,
  config: HeuristicsConfig
): number {
  const totalTime = estimateTotalTime(tasks)
  const avgParallelism = Math.max(1, metrics.avgParallelism)
  
  // Best case: perfect parallelization
  const theoreticalMin = totalTime / avgParallelism
  
  // Critical path bound: minimum time even with infinite parallelism
  // This is the sum of task durations along the longest dependency chain
  const avgTaskTime = totalTime / Math.max(1, tasks.length)
  const criticalPathTime = metrics.criticalPathLength * avgTaskTime
  
  // Actual parallel time is bounded by critical path (can't go faster than this)
  return Math.max(theoreticalMin, criticalPathTime)
}

/**
 * Determine confidence level based on speedup and parallelization ratio
 */
function determineConfidence(
  speedup: number,
  parallelizableRatio: number
): ConfidenceLevel {
  if (speedup >= 2.0 && parallelizableRatio >= 0.6) {
    return "high"
  } else if (speedup >= 1.5 && parallelizableRatio >= 0.4) {
    return "medium"
  }
  return "low"
}

/**
 * Get detailed analysis of parallelization potential
 */
export function analyzeParallelizationPotential(
  tasks: Task[],
  dependencyMap: DependencyMap
): {
  assessment: ParallelizationAssessment
  metrics: ReturnType<typeof calculateParallelizationMetrics> | null
  recommendations: string[]
} {
  const assessment = shouldParallelize(tasks, dependencyMap)
  const recommendations: string[] = []
  
  let metrics: ReturnType<typeof calculateParallelizationMetrics> | null = null
  
  try {
    const dag = buildDAG(tasks, dependencyMap)
    metrics = calculateParallelizationMetrics(dag)
    
    // Generate recommendations
    if (metrics.maxParallelism < 2) {
      recommendations.push("Consider breaking large tasks into smaller, independent subtasks.")
    }
    
    if (metrics.criticalPathLength > tasks.length * 0.7) {
      recommendations.push("Many tasks are on the critical path. Look for ways to parallelize dependencies.")
    }
    
    if (metrics.parallelizableRatio < 0.3) {
      recommendations.push("Low parallelization ratio. Review task dependencies for unnecessary constraints.")
    }
    
  } catch {
    recommendations.push("Could not analyze dependency graph. Ensure tasks have valid dependencies.")
  }
  
  if (!assessment.shouldParallelize) {
    recommendations.push("Sequential execution recommended based on current task structure.")
  }
  
  return { assessment, metrics, recommendations }
}

/**
 * Quick check if parallelization makes sense (fast, less accurate)
 * Note: This is a fast heuristic. Use shouldParallelize() for accurate analysis.
 */
export function quickParallelizationCheck(
  tasks: Task[],
  dependencyMap: DependencyMap = {}
): boolean {
  // Quick checks without building full DAG
  if (tasks.length < 3) return false
  
  // Count independent tasks (no dependencies)
  let independentCount = 0
  for (const task of tasks) {
    const deps = dependencyMap[task.id] || []
    if (deps.length === 0) {
      independentCount++
    }
  }
  
  // At least 2 independent tasks suggest parallelism opportunity
  if (independentCount >= 2) {
    return true
  }
  
  // If only 1 or 0 independent tasks, check if there's any fan-out
  // (multiple tasks depending on same parent)
  const dependentCount = new Map<TaskId, number>()
  for (const task of tasks) {
    dependentCount.set(task.id, 0)
  }
  for (const deps of Object.values(dependencyMap)) {
    for (const depId of deps) {
      if (dependentCount.has(depId)) {
        dependentCount.set(depId, (dependentCount.get(depId) || 0) + 1)
      }
    }
  }
  
  // If any task has multiple dependents, there's fan-out (parallelism after it completes)
  for (const count of dependentCount.values()) {
    if (count > 1) {
      return true
    }
  }
  
  return false
}

/**
 * Suggest optimal concurrency level
 */
export function suggestConcurrency(
  tasks: Task[],
  dependencyMap: DependencyMap,
  availableWorkers: number = 8
): number {
  try {
    const dag = buildDAG(tasks, dependencyMap)
    const metrics = calculateParallelizationMetrics(dag)
    
    // Don't use more workers than max parallelism
    const effectiveWorkers = Math.min(availableWorkers, metrics.maxParallelism)
    
    // Don't use more workers than tasks
    return Math.min(effectiveWorkers, tasks.length)
    
  } catch {
    // Default to 4 if we can't analyze
    return Math.min(4, tasks.length)
  }
}
