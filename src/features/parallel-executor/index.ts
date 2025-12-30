/**
 * Parallel Task Execution System
 * 
 * A complete system for automatic parallelization of task execution
 * based on dependency inference and DAG scheduling.
 * 
 * Features:
 * - Phase 1: Core DAG-based parallel execution
 * - Phase 2: Retry logic, caching, progress tracking
 * - Phase 3: Critical path optimization, visualization, heuristics
 */

// Core types
export type {
  Task,
  TaskId,
  TaskStatus,
  DependencyType,
  ConfidenceLevel,
  Dependency,
  DependencyMap,
  DependencyInferenceResult,
  TaskNode,
  DAG,
  ExecutionLevel,
  TaskResult,
  ExecutionConfig,
  ExecutionResult,
  ExecutionStats,
  EfficiencyMetrics,
  ProgressEvent,
  ProgressEventType,
  ProgressCallback,
  CacheEntry,
  CacheConfig,
  CriticalPathInfo,
  ReplanDecision,
  ReplanAction,
  ParallelizationAssessment,
  HeuristicsConfig,
} from "./types"

export {
  DEFAULT_EXECUTION_CONFIG,
  DEFAULT_CACHE_CONFIG,
  DEFAULT_HEURISTICS_CONFIG,
  CycleDetectedError,
  InvalidDependencyError,
  DependencyInferenceError,
  ExecutionTimeoutError,
} from "./types"

// DAG Builder
export {
  buildDAG,
  getExecutionLevels,
  getReadyTasks,
  markTaskCompleted,
  markTaskFailed,
  validateDependencyMap,
  calculateParallelizationMetrics,
} from "./dag"

// LLM Inference
export {
  inferDependencies,
  extractExplicitDependencies,
  mergeDependencies,
  type InferDependenciesOptions,
} from "./inference"

// Execution Engine
export {
  ParallelExecutor,
  calculateCriticalPath,
  prioritizeByCriticalPath,
} from "./executor"

// Cache
export {
  InferenceCache,
  createTasksCacheKey,
} from "./cache"

// Visualization
export {
  renderDAG,
  renderExecutionPlan,
  renderDependencyList,
  renderTimeline,
  renderProgressBar,
  renderExecutionSummary,
} from "./visualization"

// Heuristics
export {
  shouldParallelize,
  analyzeParallelizationPotential,
  quickParallelizationCheck,
  suggestConcurrency,
} from "./heuristics"

// Re-export BackgroundManager type for convenience
export type { BackgroundManager } from "../background-agent"
