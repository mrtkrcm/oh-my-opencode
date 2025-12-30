/**
 * Parallel Execute Tool - Type Definitions
 */

export interface ParallelExecuteArgs {
  /** Whether to analyze and show plan only (no execution) */
  analyze_only?: boolean
  /** Override default concurrency */
  max_concurrency?: number
  /** Agent to use for task execution */
  agent?: string
  /** Enable fail-fast mode */
  fail_fast?: boolean
  /** Skip parallelization if heuristics say it's not worth it */
  auto_skip?: boolean
}
