/**
 * Parallel Task Execution System - Type Definitions
 * 
 * Phase 1: Core types for DAG-based parallel execution
 * Phase 2: Error handling, retry, and caching types
 * Phase 3: Critical path, replanning, and visualization types
 */

// ============================================================================
// CORE TYPES (Phase 1)
// ============================================================================

export type TaskId = string

export type TaskStatus =
  | "pending"           // Waiting for dependencies
  | "ready"             // Dependencies met, can execute
  | "in_progress"       // Currently executing
  | "completed"         // Successfully finished
  | "failed"            // Execution failed
  | "cascade_blocked"   // Blocked due to upstream failure
  | "cancelled"         // Manually cancelled

export type DependencyType =
  | "explicit"          // Stated in task: "after X completes"
  | "data_flow"         // Task B needs output from Task A
  | "logical"           // Inferred logical ordering
  | "causal"            // A must happen before B makes sense

export type ConfidenceLevel = "high" | "medium" | "low"

/**
 * Represents a single task/todo item
 */
export interface Task {
  id: TaskId
  content: string
  status: TaskStatus
  priority: "high" | "medium" | "low"
  estimatedDuration?: number // in seconds
  metadata?: Record<string, unknown>
}

/**
 * Dependency relationship between tasks
 */
export interface Dependency {
  fromTaskId: TaskId      // Upstream task (must complete first)
  toTaskId: TaskId        // Downstream task (depends on fromTask)
  type: DependencyType
  confidence: number      // 0-1, LLM's confidence in inference
  reason: string          // Human-readable explanation
}

/**
 * Dependency map: taskId → [dependencies that must complete first]
 */
export type DependencyMap = Record<TaskId, TaskId[]>

/**
 * Result of LLM dependency inference
 */
export interface DependencyInferenceResult {
  dependencies: DependencyMap
  reasoning: Record<TaskId, string>
  confidence: ConfidenceLevel
  warnings: string[]
  tokensUsed?: number
  inferenceTimeMs: number
}

// ============================================================================
// DAG TYPES (Phase 1)
// ============================================================================

/**
 * Node in the task dependency graph
 */
export interface TaskNode {
  task: Task
  status: TaskStatus
  dependencies: Set<TaskId>     // Tasks this depends on
  dependents: Set<TaskId>       // Tasks that depend on this
  inDegree: number              // Number of unmet dependencies
  layer: number                 // Parallel execution layer
  result?: TaskResult
}

/**
 * Constructed DAG with all necessary lookup structures
 */
export interface DAG {
  /** taskId → TaskNode */
  nodes: Map<TaskId, TaskNode>
  
  /** All dependency edges */
  edges: Dependency[]
  
  /** Valid topological ordering of task IDs */
  topologicalOrder: TaskId[]
  
  /** taskId → Set of taskIds that depend on it (reverse lookup) */
  reverseDependencies: Map<TaskId, Set<TaskId>>
  
  /** Original dependency map from inference */
  dependencyMap: DependencyMap
}

/**
 * A group of tasks that can execute in parallel
 */
export interface ExecutionLevel {
  /** 0-indexed level number */
  level: number
  
  /** Task IDs in this level */
  taskIds: TaskId[]
  
  /** Full task objects */
  tasks: Task[]
  
  /** Number of tasks that can run in parallel */
  parallelism: number
}

// ============================================================================
// EXECUTION TYPES (Phase 1 & 2)
// ============================================================================

/**
 * Result of a single task execution
 */
export interface TaskResult {
  taskId: TaskId
  status: "completed" | "failed" | "timeout" | "cancelled"
  output?: unknown
  error?: string
  durationMs: number
  retryCount: number
  agentUsed?: string
}

/**
 * Configuration for execution engine
 */
export interface ExecutionConfig {
  /** Maximum tasks to run simultaneously (default: 4) */
  maxConcurrency: number
  
  /** Timeout per task in milliseconds (default: 300000 = 5 min) */
  taskTimeoutMs: number
  
  /** Total execution timeout in milliseconds */
  totalTimeoutMs?: number
  
  /** Stop all execution on first failure */
  failFast: boolean
  
  /** Number of retries for failed tasks (Phase 2) */
  retryCount: number
  
  /** Initial delay between retries in ms (Phase 2) */
  retryDelayMs: number
  
  /** Backoff multiplier for retries (Phase 2) */
  retryBackoffMultiplier: number
  
  /** Agent to use for task execution */
  defaultAgent: string
  
  /** Enable progress callbacks (Phase 2) */
  enableProgress: boolean
  
  /** Enable critical path optimization (Phase 3) */
  enableCriticalPath: boolean
  
  /** Parent session ID for background task creation */
  parentSessionID?: string
  
  /** Parent message ID for background task creation */
  parentMessageID?: string
}

/**
 * Default execution configuration
 */
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  maxConcurrency: 4,
  taskTimeoutMs: 300000,
  totalTimeoutMs: 1800000, // 30 minutes
  failFast: false,
  retryCount: 2,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,
  defaultAgent: "general",
  enableProgress: true,
  enableCriticalPath: false,
}

/**
 * Overall execution result
 */
export interface ExecutionResult {
  /** Overall status */
  status: "success" | "partial_success" | "failed"
  
  /** Individual task results */
  taskResults: Map<TaskId, TaskResult>
  
  /** Summary statistics */
  stats: ExecutionStats
  
  /** Tasks that were blocked due to upstream failures */
  cascadeBlocked: TaskId[]
  
  /** Total execution time */
  totalDurationMs: number
  
  /** Parallelization efficiency metrics (Phase 2) */
  efficiency?: EfficiencyMetrics
}

export interface ExecutionStats {
  total: number
  completed: number
  failed: number
  cascadeBlocked: number
  cancelled: number
  retried: number
}

export interface EfficiencyMetrics {
  /** Actual wall-clock time */
  actualDurationMs: number
  
  /** If all tasks ran sequentially (sum of task durations) */
  theoreticalSequentialMs: number
  
  /** Speedup factor = sequential / actual */
  speedupFactor: number
  
  /** Average tasks per level */
  avgParallelism: number
  
  /** Max tasks in any level */
  maxParallelism: number
}

// ============================================================================
// PROGRESS & CALLBACKS (Phase 2)
// ============================================================================

export type ProgressEventType =
  | "execution_start"
  | "level_start"
  | "level_complete"
  | "task_start"
  | "task_complete"
  | "task_failed"
  | "task_retry"
  | "cascade_block"
  | "execution_complete"

/**
 * Progress update for callbacks
 */
export interface ProgressEvent {
  type: ProgressEventType
  timestamp: Date
  level?: number
  taskId?: TaskId
  taskContent?: string
  completed: number
  total: number
  failed: number
  blocked: number
  message?: string
}

export type ProgressCallback = (event: ProgressEvent) => void | Promise<void>

// ============================================================================
// CACHING TYPES (Phase 2)
// ============================================================================

export interface CacheEntry {
  key: string
  dependencies: DependencyMap
  reasoning: Record<TaskId, string>
  confidence: ConfidenceLevel
  createdAt: Date
  hitCount: number
}

export interface CacheConfig {
  /** Maximum entries in cache */
  maxSize: number
  /** TTL in milliseconds */
  ttlMs: number
  /** Enable cache */
  enabled: boolean
}

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  maxSize: 100,
  ttlMs: 3600000, // 1 hour
  enabled: true,
}

// ============================================================================
// CRITICAL PATH TYPES (Phase 3)
// ============================================================================

export interface CriticalPathInfo {
  /** Task IDs on the critical path */
  criticalPath: TaskId[]
  
  /** Total project duration (sum of critical path) */
  projectDuration: number
  
  /** Slack time for each task (0 = critical) */
  slackByTask: Map<TaskId, number>
  
  /** Earliest start time for each task */
  earliestStart: Map<TaskId, number>
  
  /** Latest start time for each task */
  latestStart: Map<TaskId, number>
}

// ============================================================================
// REPLANNING TYPES (Phase 3)
// ============================================================================

export type ReplanAction =
  | "retry"               // Retry the failed task
  | "retry_modified"      // Retry with different approach
  | "skip"                // Skip and continue
  | "substitute"          // Replace with alternative
  | "abort"               // Abort entire execution

export interface ReplanDecision {
  action: ReplanAction
  reason: string
  modifications?: Record<string, unknown>
  substituteTask?: Task
}

// ============================================================================
// HEURISTICS TYPES (Phase 3)
// ============================================================================

export interface ParallelizationAssessment {
  shouldParallelize: boolean
  reason: string
  estimatedSpeedup?: number
  estimatedOverhead?: number
  confidence: ConfidenceLevel
}

export interface HeuristicsConfig {
  /** Minimum tasks to consider parallelization */
  minTasks: number
  /** Minimum total estimated time (seconds) */
  minTotalTime: number
  /** Minimum parallelizable ratio */
  minParallelizableRatio: number
  /** Overhead per task (seconds) */
  overheadPerTask: number
  /** Fixed overhead (seconds) */
  fixedOverhead: number
}

export const DEFAULT_HEURISTICS_CONFIG: HeuristicsConfig = {
  minTasks: 3,
  minTotalTime: 30,
  minParallelizableRatio: 0.3,
  overheadPerTask: 1,
  fixedOverhead: 5,
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class CycleDetectedError extends Error {
  constructor(
    message: string,
    public readonly cycle: TaskId[]
  ) {
    super(message)
    this.name = "CycleDetectedError"
  }
}

export class InvalidDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InvalidDependencyError"
  }
}

export class DependencyInferenceError extends Error {
  constructor(
    message: string,
    public readonly rawResponse?: string,
    public readonly parseError?: Error
  ) {
    super(message)
    this.name = "DependencyInferenceError"
  }
}

export class ExecutionTimeoutError extends Error {
  constructor(
    message: string,
    public readonly taskId: TaskId,
    public readonly timeoutMs: number
  ) {
    super(message)
    this.name = "ExecutionTimeoutError"
  }
}
