/**
 * DAG Builder - Directed Acyclic Graph Construction
 * 
 * Implements Kahn's algorithm for:
 * - Topological sorting
 * - Cycle detection
 * - Level computation for parallel execution
 */

import type {
  Task,
  TaskId,
  TaskNode,
  DAG,
  DependencyMap,
  Dependency,
  ExecutionLevel,
} from "./types"
import { CycleDetectedError, InvalidDependencyError } from "./types"

/**
 * Build a DAG from tasks and their dependencies
 * Uses Kahn's algorithm for topological sort with cycle detection
 * 
 * @param tasks - Array of tasks to schedule
 * @param dependencyMap - Map of taskId to array of dependency taskIds
 * @returns Constructed DAG
 * @throws CycleDetectedError if circular dependencies exist
 * @throws InvalidDependencyError if dependencies reference non-existent tasks
 */
export function buildDAG(tasks: Task[], dependencyMap: DependencyMap): DAG {
  const nodes = new Map<TaskId, TaskNode>()
  const edges: Dependency[] = []
  const reverseDependencies = new Map<TaskId, Set<TaskId>>()
  
  // Initialize task nodes
  for (const task of tasks) {
    nodes.set(task.id, {
      task,
      status: "pending",
      dependencies: new Set(),
      dependents: new Set(),
      inDegree: 0,
      layer: -1,
    })
    reverseDependencies.set(task.id, new Set())
  }
  
  // Build edges from dependency map
  for (const [taskId, deps] of Object.entries(dependencyMap)) {
    const node = nodes.get(taskId)
    if (!node) {
      // Task referenced in dependencies but not in task list - skip
      continue
    }
    
    for (const depId of deps) {
      // Validate dependency exists
      const depNode = nodes.get(depId)
      if (!depNode) {
        throw new InvalidDependencyError(
          `Task "${taskId}" depends on non-existent task "${depId}"`
        )
      }
      
      // Add edge: depId → taskId (depId must complete before taskId)
      node.dependencies.add(depId)
      node.inDegree++
      
      // Update dependent's dependents set
      depNode.dependents.add(taskId)
      
      // Build reverse lookup
      reverseDependencies.get(depId)!.add(taskId)
      
      // Create edge record
      edges.push({
        fromTaskId: depId,
        toTaskId: taskId,
        type: "logical",
        confidence: 1.0,
        reason: "Inferred dependency",
      })
    }
  }
  
  // Perform topological sort using Kahn's algorithm
  const topologicalOrder = kahnTopologicalSort(nodes)
  
  // Compute execution layers using topological order
  computeLayers(nodes, dependencyMap, topologicalOrder)
  
  return {
    nodes,
    edges,
    topologicalOrder,
    reverseDependencies,
    dependencyMap,
  }
}

/**
 * Kahn's algorithm for topological sorting
 * Also detects cycles in the graph
 * 
 * Time complexity: O(V + E)
 * Space complexity: O(V)
 */
function kahnTopologicalSort(nodes: Map<TaskId, TaskNode>): TaskId[] {
  const inDegree = new Map<TaskId, number>()
  const queue: TaskId[] = []
  const sorted: TaskId[] = []
  
  // Initialize in-degrees
  for (const [taskId, node] of nodes) {
    inDegree.set(taskId, node.inDegree)
    if (node.inDegree === 0) {
      queue.push(taskId)
    }
  }
  
  // Process queue
  while (queue.length > 0) {
    const current = queue.shift()!
    sorted.push(current)
    
    const node = nodes.get(current)!
    for (const dependentId of node.dependents) {
      const newDegree = inDegree.get(dependentId)! - 1
      inDegree.set(dependentId, newDegree)
      
      if (newDegree === 0) {
        queue.push(dependentId)
      }
    }
  }
  
  // Cycle detection: if we couldn't sort all nodes, there's a cycle
  if (sorted.length !== nodes.size) {
    const cycleNodes = Array.from(nodes.keys()).filter(id => !sorted.includes(id))
    const cycle = findCycle(cycleNodes, nodes)
    
    throw new CycleDetectedError(
      `Circular dependency detected: ${cycle.join(" → ")}`,
      cycle
    )
  }
  
  return sorted
}

/**
 * Find a cycle in the dependency graph using DFS
 * Used for error reporting when a cycle is detected
 */
function findCycle(nodeIds: TaskId[], nodes: Map<TaskId, TaskNode>): TaskId[] {
  const visited = new Set<TaskId>()
  const recursionStack = new Set<TaskId>()
  const path: TaskId[] = []
  
  function dfs(nodeId: TaskId): TaskId[] | null {
    visited.add(nodeId)
    recursionStack.add(nodeId)
    path.push(nodeId)
    
    const node = nodes.get(nodeId)
    if (node) {
      for (const depId of node.dependencies) {
        if (!visited.has(depId)) {
          const cycle = dfs(depId)
          if (cycle) return cycle
        } else if (recursionStack.has(depId)) {
          // Found cycle - extract it from path
          const cycleStart = path.indexOf(depId)
          return [...path.slice(cycleStart), depId]
        }
      }
    }
    
    path.pop()
    recursionStack.delete(nodeId)
    return null
  }
  
  for (const nodeId of nodeIds) {
    if (!visited.has(nodeId)) {
      const cycle = dfs(nodeId)
      if (cycle) return cycle
    }
  }
  
  return nodeIds // Fallback if cycle not found (shouldn't happen)
}

/**
 * Compute execution layers for parallel processing
 * Tasks in the same layer have no dependencies on each other
 * 
 * Layer 0: Tasks with no dependencies
 * Layer N: Tasks whose dependencies are all in layers < N
 */
function computeLayers(
  nodes: Map<TaskId, TaskNode>,
  dependencyMap: DependencyMap,
  topologicalOrder: TaskId[]
): void {
  const taskLevels = new Map<TaskId, number>()
  
  // Process nodes in topological order (dependencies before dependents)
  // This ensures all dependencies have computed levels before we compute the current node's level
  for (const taskId of topologicalOrder) {
    const node = nodes.get(taskId)
    if (!node) continue
    
    const deps = dependencyMap[taskId] || []
    
    if (deps.length === 0) {
      taskLevels.set(taskId, 0)
      node.layer = 0
    } else {
      // Level = max(dependency levels) + 1
      // All dependencies are guaranteed to have levels computed already (topological order)
      const maxDepLevel = Math.max(
        ...deps.map(depId => taskLevels.get(depId) ?? 0)
      )
      const level = maxDepLevel + 1
      taskLevels.set(taskId, level)
      node.layer = level
    }
  }
}

/**
 * Get execution levels from a DAG
 * Returns tasks grouped by level for parallel execution
 */
export function getExecutionLevels(dag: DAG): ExecutionLevel[] {
  const levelGroups = new Map<number, TaskId[]>()
  
  // Group tasks by level
  for (const [taskId, node] of dag.nodes) {
    const level = node.layer
    if (!levelGroups.has(level)) {
      levelGroups.set(level, [])
    }
    levelGroups.get(level)!.push(taskId)
  }
  
  // Convert to ExecutionLevel objects, sorted by level
  const maxLevel = Math.max(...levelGroups.keys(), -1)
  const levels: ExecutionLevel[] = []
  
  for (let i = 0; i <= maxLevel; i++) {
    const taskIds = levelGroups.get(i) || []
    levels.push({
      level: i,
      taskIds,
      tasks: taskIds.map(id => dag.nodes.get(id)!.task),
      parallelism: taskIds.length,
    })
  }
  
  return levels
}

/**
 * Get tasks that are ready to execute (all dependencies completed)
 */
export function getReadyTasks(dag: DAG): Task[] {
  const ready: Task[] = []
  
  for (const [_, node] of dag.nodes) {
    if (node.status === "pending" && isTaskReady(node, dag)) {
      ready.push(node.task)
      node.status = "ready"
    }
  }
  
  return ready
}

/**
 * Check if a task is ready to execute
 * A task is ready when all its dependencies are completed
 */
function isTaskReady(node: TaskNode, dag: DAG): boolean {
  for (const depId of node.dependencies) {
    const depNode = dag.nodes.get(depId)
    if (!depNode || depNode.status !== "completed") {
      return false
    }
  }
  return true
}

/**
 * Mark a task as completed and return newly ready tasks
 */
export function markTaskCompleted(dag: DAG, taskId: TaskId): Task[] {
  const node = dag.nodes.get(taskId)
  if (!node) return []
  
  node.status = "completed"
  
  // Find tasks that are now ready
  const newlyReady: Task[] = []
  
  for (const dependentId of node.dependents) {
    const dependent = dag.nodes.get(dependentId)
    if (dependent && dependent.status === "pending" && isTaskReady(dependent, dag)) {
      dependent.status = "ready"
      newlyReady.push(dependent.task)
    }
  }
  
  return newlyReady
}

/**
 * Mark a task as failed and cascade block all dependents
 */
export function markTaskFailed(dag: DAG, taskId: TaskId): TaskId[] {
  const node = dag.nodes.get(taskId)
  if (!node) return []
  
  node.status = "failed"
  
  // Cascade block all downstream tasks
  const blocked: TaskId[] = []
  const queue = [taskId]
  const visited = new Set<TaskId>()
  
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    
    const currentNode = dag.nodes.get(current)
    if (!currentNode) continue
    
    for (const dependentId of currentNode.dependents) {
      const dependent = dag.nodes.get(dependentId)
      if (dependent && dependent.status === "pending") {
        dependent.status = "cascade_blocked"
        blocked.push(dependentId)
        queue.push(dependentId)
      }
    }
  }
  
  return blocked
}

/**
 * Validate a dependency map for potential issues
 * Returns warnings for non-fatal issues
 */
export function validateDependencyMap(
  tasks: Task[],
  dependencyMap: DependencyMap
): string[] {
  const warnings: string[] = []
  const taskIds = new Set(tasks.map(t => t.id))
  
  // Check for references to non-existent tasks
  for (const [taskId, deps] of Object.entries(dependencyMap)) {
    if (!taskIds.has(taskId)) {
      warnings.push(`Dependency map references unknown task: ${taskId}`)
    }
    
    for (const depId of deps) {
      if (!taskIds.has(depId)) {
        warnings.push(`Task "${taskId}" depends on unknown task "${depId}"`)
      }
    }
    
    // Check for self-dependency
    if (deps.includes(taskId)) {
      warnings.push(`Task "${taskId}" depends on itself`)
    }
  }
  
  // Check for tasks with no path to completion (isolated cycles would be caught elsewhere)
  const tasksWithDeps = new Set(Object.keys(dependencyMap))
  const tasksAsDeps = new Set(Object.values(dependencyMap).flat())
  
  for (const task of tasks) {
    if (!tasksWithDeps.has(task.id) && !tasksAsDeps.has(task.id) && tasks.length > 1) {
      // Task is completely isolated - this might be intentional
      // Not adding a warning for this case
    }
  }
  
  return warnings
}

/**
 * Calculate parallelization metrics for a DAG
 */
export function calculateParallelizationMetrics(dag: DAG): {
  totalTasks: number
  maxParallelism: number
  avgParallelism: number
  criticalPathLength: number
  parallelizableRatio: number
} {
  const levels = getExecutionLevels(dag)
  
  const totalTasks = dag.nodes.size
  const maxParallelism = Math.max(...levels.map(l => l.parallelism), 1)
  const avgParallelism = totalTasks / Math.max(levels.length, 1)
  const criticalPathLength = levels.length
  
  // Parallelizable ratio: how many tasks can run in parallel vs total
  // Higher is better, 1.0 means all tasks can run in one level
  const parallelizableRatio = levels.length > 0
    ? 1 - (levels.length - 1) / Math.max(totalTasks - 1, 1)
    : 1
  
  return {
    totalTasks,
    maxParallelism,
    avgParallelism,
    criticalPathLength,
    parallelizableRatio,
  }
}
