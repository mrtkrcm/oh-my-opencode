/**
 * DAG Visualization - ASCII Art Rendering
 * 
 * Phase 3: Provides visual representation of task dependency graph
 */

import type {
  Task,
  TaskId,
  DAG,
  ExecutionLevel,
  CriticalPathInfo,
  TaskStatus,
} from "./types"
import { getExecutionLevels } from "./dag"

/**
 * Render DAG as ASCII art
 */
export function renderDAG(dag: DAG): string {
  const levels = getExecutionLevels(dag)
  const lines: string[] = []
  
  lines.push("┌─────────────────────────────────────────────────────────────────┐")
  lines.push("│                      TASK DEPENDENCY GRAPH                       │")
  lines.push("├─────────────────────────────────────────────────────────────────┤")
  
  for (const level of levels) {
    lines.push(`│  Level ${level.level}: ${level.tasks.length} task(s)                                         │`.slice(0, 67) + "│")
    
    for (const task of level.tasks) {
      const node = dag.nodes.get(task.id)
      const status = node?.status || "pending"
      const statusIcon = getStatusIcon(status)
      const deps = node?.dependencies.size || 0
      
      const taskLine = `│    ${statusIcon} [${task.id}] ${truncate(task.content, 40)} (${deps} deps)`
      lines.push(padRight(taskLine, 66) + "│")
    }
    
    if (level.level < levels.length - 1) {
      lines.push("│                               ↓                                 │")
    }
  }
  
  lines.push("└─────────────────────────────────────────────────────────────────┘")
  
  return lines.join("\n")
}

/**
 * Render execution plan summary
 */
export function renderExecutionPlan(
  dag: DAG,
  criticalPath?: CriticalPathInfo
): string {
  const levels = getExecutionLevels(dag)
  const lines: string[] = []
  
  lines.push("## Execution Plan\n")
  lines.push("```")
  
  // Summary stats
  const totalTasks = dag.nodes.size
  const maxParallelism = Math.max(...levels.map(l => l.parallelism), 1)
  const criticalPathLength = levels.length
  
  lines.push(`Total Tasks: ${totalTasks}`)
  lines.push(`Execution Levels: ${criticalPathLength}`)
  lines.push(`Max Parallelism: ${maxParallelism}`)
  
  if (criticalPath) {
    lines.push(`Critical Path: ${criticalPath.criticalPath.join(" → ")}`)
    lines.push(`Estimated Duration: ${criticalPath.projectDuration} units`)
  }
  
  lines.push("")
  lines.push("Level-by-Level Execution:")
  lines.push("─".repeat(50))
  
  for (const level of levels) {
    lines.push(`\nLevel ${level.level}:`)
    
    for (const task of level.tasks) {
      const node = dag.nodes.get(task.id)
      const isCritical = criticalPath?.criticalPath.includes(task.id)
      const slack = criticalPath?.slackByTask.get(task.id)
      
      const criticalMarker = isCritical ? " ⚡" : ""
      const slackInfo = slack !== undefined ? ` (slack: ${slack})` : ""
      
      lines.push(`  [${task.id}] ${truncate(task.content, 35)}${criticalMarker}${slackInfo}`)
      
      // Show dependencies
      if (node && node.dependencies.size > 0) {
        lines.push(`       └── depends on: ${Array.from(node.dependencies).join(", ")}`)
      }
    }
  }
  
  lines.push("```")
  
  return lines.join("\n")
}

/**
 * Render a simple dependency list
 */
export function renderDependencyList(
  dag: DAG,
  reasoning?: Record<TaskId, string>
): string {
  const lines: string[] = []
  
  lines.push("## Task Dependencies\n")
  
  for (const [taskId, node] of dag.nodes) {
    const depsArray = Array.from(node.dependencies)
    const depStr = depsArray.length > 0 ? depsArray.join(", ") : "(none)"
    const reason = reasoning?.[taskId]
    
    lines.push(`**[${taskId}]** ${truncate(node.task.content, 50)}`)
    lines.push(`  - Dependencies: ${depStr}`)
    if (reason) {
      lines.push(`  - Reason: ${reason}`)
    }
    lines.push("")
  }
  
  return lines.join("\n")
}

/**
 * Render execution timeline (Gantt-like)
 */
export function renderTimeline(
  levels: ExecutionLevel[],
  taskDurations?: Map<TaskId, number>
): string {
  const lines: string[] = []
  const width = 60
  
  lines.push("## Execution Timeline\n")
  lines.push("```")
  
  // Header
  lines.push("Time →")
  lines.push("─".repeat(width))
  
  let currentTime = 0
  
  for (const level of levels) {
    // Calculate level duration (max of task durations in level)
    const levelDuration = taskDurations
      ? Math.max(...level.tasks.map(t => taskDurations.get(t.id) || 1), 1)
      : 1
    
    // Render tasks in this level
    for (const task of level.tasks) {
      const duration = taskDurations?.get(task.id) || 1
      const barLength = Math.max(Math.round(duration * 3), 3)
      const offset = Math.round(currentTime * 3)
      
      const bar = "█".repeat(barLength)
      const padding = " ".repeat(Math.min(offset, width - barLength - 10))
      const label = `[${task.id}]`
      
      lines.push(`${padding}${bar} ${label}`)
    }
    
    currentTime += levelDuration
    
    if (level.level < levels.length - 1) {
      lines.push("│")
    }
  }
  
  lines.push("─".repeat(width))
  lines.push("```")
  
  return lines.join("\n")
}

/**
 * Render progress bar for execution
 */
export function renderProgressBar(
  completed: number,
  total: number,
  failed: number,
  blocked: number,
  width: number = 40
): string {
  const remaining = total - completed - failed - blocked
  
  const completedWidth = Math.round((completed / total) * width)
  const failedWidth = Math.round((failed / total) * width)
  const blockedWidth = Math.round((blocked / total) * width)
  const remainingWidth = width - completedWidth - failedWidth - blockedWidth
  
  const bar = 
    "█".repeat(completedWidth) +
    "✗".repeat(failedWidth) +
    "░".repeat(blockedWidth) +
    "·".repeat(Math.max(0, remainingWidth))
  
  const percent = Math.round((completed / total) * 100)
  
  return `[${bar}] ${percent}% (${completed}/${total} done, ${failed} failed, ${blocked} blocked)`
}

/**
 * Render execution result summary
 */
export function renderExecutionSummary(
  stats: {
    total: number
    completed: number
    failed: number
    cascadeBlocked: number
    retried: number
  },
  durationMs: number,
  speedup: number
): string {
  const lines: string[] = []
  
  lines.push("## Execution Summary\n")
  lines.push("```")
  lines.push(`┌─────────────────────────────────────┐`)
  lines.push(`│          EXECUTION COMPLETE          │`)
  lines.push(`├─────────────────────────────────────┤`)
  lines.push(`│  Total Tasks:     ${padLeft(String(stats.total), 5)}              │`)
  lines.push(`│  Completed:       ${padLeft(String(stats.completed), 5)} ✓            │`)
  lines.push(`│  Failed:          ${padLeft(String(stats.failed), 5)} ✗            │`)
  lines.push(`│  Blocked:         ${padLeft(String(stats.cascadeBlocked), 5)} ░            │`)
  lines.push(`│  Retried:         ${padLeft(String(stats.retried), 5)}              │`)
  lines.push(`├─────────────────────────────────────┤`)
  lines.push(`│  Duration:        ${formatDuration(durationMs).padStart(10)}      │`)
  lines.push(`│  Speedup:         ${speedup.toFixed(2).padStart(10)}x     │`)
  lines.push(`└─────────────────────────────────────┘`)
  lines.push("```")
  
  return lines.join("\n")
}

// Helper functions

function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "completed": return "✓"
    case "failed": return "✗"
    case "in_progress": return "▶"
    case "ready": return "○"
    case "cascade_blocked": return "░"
    case "cancelled": return "⊘"
    default: return "·"
  }
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str
  return str.slice(0, maxLength - 3) + "..."
}

function padRight(str: string, length: number): string {
  if (str.length >= length) return str.slice(0, length)
  return str + " ".repeat(length - str.length)
}

function padLeft(str: string, length: number): string {
  if (str.length >= length) return str
  return " ".repeat(length - str.length) + str
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`
  }
  return `${seconds}s`
}
