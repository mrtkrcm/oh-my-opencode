/**
 * LLM Dependency Inference Module
 * 
 * Uses LLM to automatically infer dependencies between tasks
 * from their natural language descriptions.
 */

import type {
  Task,
  TaskId,
  DependencyMap,
  DependencyInferenceResult,
  ConfidenceLevel,
} from "./types"
import { DependencyInferenceError } from "./types"

/**
 * System prompt for dependency inference
 */
const DEPENDENCY_INFERENCE_SYSTEM_PROMPT = `You are a task dependency analyzer. Given a list of tasks, you must identify which tasks depend on other tasks being completed first.

RULES:
1. A task A depends on task B if A cannot START until B is COMPLETED
2. Only include DIRECT dependencies (not transitive - if A→B→C, don't add A→C)
3. Be CONSERVATIVE - when uncertain, assume tasks are independent (false negatives are safer than false positives causing deadlocks)
4. Consider these dependency patterns:
   - Data dependencies: Task needs output/artifact from another task
   - Logical dependencies: Task needs state/context from another task
   - Resource dependencies: Task needs resource created by another task
   - Build dependencies: Compilation/build order requirements

CRITICAL:
- Do NOT create cycles (A→B→A is invalid)
- Do NOT infer dependencies just because tasks are related
- DO mark as independent if tasks can run simultaneously without conflict
- Empty array [] means the task has no dependencies and can start immediately`

/**
 * Build the user prompt for dependency inference
 */
function buildInferencePrompt(tasks: Task[]): string {
  const taskList = tasks
    .map((t, i) => `[${t.id}] ${t.content}`)
    .join("\n")
  
  return `Analyze these tasks and identify dependencies:

TASKS:
${taskList}

For each task, list which other tasks (by ID) must complete BEFORE it can start.

Return ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "dependencies": {
    "<task_id>": ["<dependency_id>", ...],
    ...
  },
  "reasoning": {
    "<task_id>": "<brief one-sentence explanation>",
    ...
  },
  "confidence": "high" | "medium" | "low",
  "warnings": ["<any concerns about ambiguous dependencies>"]
}

IMPORTANT:
- Include ALL task IDs in dependencies (use empty array [] for tasks with no dependencies)
- Use the exact task IDs provided (e.g., "1", "2", not "task_1")
- Do not include any text outside the JSON object`
}

/**
 * Parse the LLM response into structured data
 */
function parseInferenceResponse(response: string, tasks: Task[]): {
  dependencies: DependencyMap
  reasoning: Record<TaskId, string>
  confidence: ConfidenceLevel
  warnings: string[]
} {
  // Try to extract JSON from the response
  let jsonStr = response.trim()
  
  // Handle markdown code blocks
  const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim()
  }
  
  // Handle responses that start with explanatory text
  const jsonStart = jsonStr.indexOf("{")
  const jsonEnd = jsonStr.lastIndexOf("}")
  if (jsonStart !== -1 && jsonEnd !== -1) {
    jsonStr = jsonStr.slice(jsonStart, jsonEnd + 1)
  }
  
  let parsed: {
    dependencies?: Record<string, string[]>
    reasoning?: Record<string, string>
    confidence?: string
    warnings?: string[]
  }
  
  try {
    parsed = JSON.parse(jsonStr)
  } catch (parseError) {
    throw new DependencyInferenceError(
      "Failed to parse LLM response as JSON",
      response,
      parseError instanceof Error ? parseError : new Error(String(parseError))
    )
  }
  
  // Validate and normalize the response
  const dependencies: DependencyMap = {}
  const reasoning: Record<TaskId, string> = {}
  const taskIds = new Set(tasks.map(t => t.id))
  
  // Process dependencies
  if (parsed.dependencies && typeof parsed.dependencies === "object") {
    for (const [taskId, deps] of Object.entries(parsed.dependencies)) {
      if (!taskIds.has(taskId)) {
        // Skip unknown tasks but don't error
        continue
      }
      
      if (Array.isArray(deps)) {
        // Filter to only valid task IDs
        dependencies[taskId] = deps.filter(depId => 
          typeof depId === "string" && taskIds.has(depId) && depId !== taskId
        )
      } else {
        dependencies[taskId] = []
      }
    }
  }
  
  // Ensure all tasks have an entry
  for (const task of tasks) {
    if (!(task.id in dependencies)) {
      dependencies[task.id] = []
    }
  }
  
  // Process reasoning
  if (parsed.reasoning && typeof parsed.reasoning === "object") {
    for (const [taskId, reason] of Object.entries(parsed.reasoning)) {
      if (taskIds.has(taskId) && typeof reason === "string") {
        reasoning[taskId] = reason
      }
    }
  }
  
  // Validate confidence
  let confidence: ConfidenceLevel = "medium"
  if (parsed.confidence === "high" || parsed.confidence === "low") {
    confidence = parsed.confidence
  }
  
  // Process warnings
  const warnings: string[] = []
  if (Array.isArray(parsed.warnings)) {
    for (const w of parsed.warnings) {
      if (typeof w === "string") {
        warnings.push(w)
      }
    }
  }
  
  return { dependencies, reasoning, confidence, warnings }
}

/**
 * Detect potential cycles in the inferred dependencies
 * Returns the cycle if found, empty array otherwise
 */
function detectCycle(dependencies: DependencyMap): TaskId[] {
  const visited = new Set<TaskId>()
  const recursionStack = new Set<TaskId>()
  const path: TaskId[] = []
  
  function dfs(taskId: TaskId): TaskId[] | null {
    visited.add(taskId)
    recursionStack.add(taskId)
    path.push(taskId)
    
    const deps = dependencies[taskId] || []
    for (const depId of deps) {
      if (!visited.has(depId)) {
        const cycle = dfs(depId)
        if (cycle) return cycle
      } else if (recursionStack.has(depId)) {
        // Found cycle
        const cycleStart = path.indexOf(depId)
        return [...path.slice(cycleStart), depId]
      }
    }
    
    path.pop()
    recursionStack.delete(taskId)
    return null
  }
  
  for (const taskId of Object.keys(dependencies)) {
    if (!visited.has(taskId)) {
      const cycle = dfs(taskId)
      if (cycle) return cycle
    }
  }
  
  return []
}

/**
 * Break a cycle by removing the edge with lowest confidence
 * In this case, we remove the last edge in the cycle path
 */
function breakCycle(dependencies: DependencyMap, cycle: TaskId[]): void {
  if (cycle.length < 2) return
  
  // Remove the edge from the second-to-last to the last node
  // This is often the "back edge" that creates the cycle
  const toNode = cycle[cycle.length - 1]
  const fromNode = cycle[cycle.length - 2]
  
  if (dependencies[toNode]) {
    dependencies[toNode] = dependencies[toNode].filter(d => d !== fromNode)
  }
}

export interface InferDependenciesOptions {
  /** Function to call LLM with prompt */
  callLLM: (systemPrompt: string, userPrompt: string) => Promise<string>
  /** Maximum retries on parse failure */
  maxRetries?: number
  /** Auto-fix cycles by removing edges */
  autoFixCycles?: boolean
}

/**
 * Infer dependencies between tasks using LLM
 */
export async function inferDependencies(
  tasks: Task[],
  options: InferDependenciesOptions
): Promise<DependencyInferenceResult> {
  const { callLLM, maxRetries = 2, autoFixCycles = true } = options
  
  if (tasks.length === 0) {
    return {
      dependencies: {},
      reasoning: {},
      confidence: "high",
      warnings: [],
      inferenceTimeMs: 0,
    }
  }
  
  if (tasks.length === 1) {
    return {
      dependencies: { [tasks[0].id]: [] },
      reasoning: { [tasks[0].id]: "Single task, no dependencies" },
      confidence: "high",
      warnings: [],
      inferenceTimeMs: 0,
    }
  }
  
  const startTime = Date.now()
  const userPrompt = buildInferencePrompt(tasks)
  
  let lastError: Error | null = null
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await callLLM(DEPENDENCY_INFERENCE_SYSTEM_PROMPT, userPrompt)
      const parsed = parseInferenceResponse(response, tasks)
      
      // Check for cycles
      let cycle = detectCycle(parsed.dependencies)
      
      if (cycle.length > 0) {
        if (autoFixCycles) {
          // Break cycles automatically
          while (cycle.length > 0) {
            parsed.warnings.push(`Auto-fixed cycle: ${cycle.join(" → ")}`)
            breakCycle(parsed.dependencies, cycle)
            cycle = detectCycle(parsed.dependencies)
          }
        } else {
          throw new DependencyInferenceError(
            `Circular dependency detected: ${cycle.join(" → ")}`,
            response
          )
        }
      }
      
      return {
        ...parsed,
        inferenceTimeMs: Date.now() - startTime,
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      // Only retry on parse errors, not on LLM errors
      if (!(error instanceof DependencyInferenceError)) {
        throw error
      }
    }
  }
  
  throw lastError || new DependencyInferenceError("Failed to infer dependencies")
}

/**
 * Extract explicit dependencies from task content
 * Looks for patterns like "after X", "depends on Y", "requires Z"
 */
export function extractExplicitDependencies(tasks: Task[]): DependencyMap {
  const dependencies: DependencyMap = {}
  const taskIdsByContent = new Map<string, TaskId>()
  
  // Build index of task content keywords
  for (const task of tasks) {
    const words = task.content.toLowerCase().split(/\s+/)
    for (const word of words) {
      if (word.length > 3) {
        taskIdsByContent.set(word, task.id)
      }
    }
    dependencies[task.id] = []
  }
  
  // Dependency pattern matchers
  const patterns = [
    /after\s+(?:completing?\s+)?["']?([^"']+)["']?/gi,
    /depends?\s+on\s+["']?([^"']+)["']?/gi,
    /requires?\s+["']?([^"']+)["']?/gi,
    /following\s+["']?([^"']+)["']?/gi,
    /once\s+["']?([^"']+)["']?\s+is\s+(?:done|complete)/gi,
  ]
  
  for (const task of tasks) {
    const content = task.content.toLowerCase()
    
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      let match
      
      while ((match = pattern.exec(content)) !== null) {
        const reference = match[1].trim().toLowerCase()
        
        // Try to find matching task
        for (const otherTask of tasks) {
          if (otherTask.id === task.id) continue
          
          const otherContent = otherTask.content.toLowerCase()
          if (otherContent.includes(reference) || reference.includes(otherContent.slice(0, 20))) {
            if (!dependencies[task.id].includes(otherTask.id)) {
              dependencies[task.id].push(otherTask.id)
            }
            break
          }
        }
      }
    }
  }
  
  return dependencies
}

/**
 * Merge explicit and inferred dependencies
 * Explicit dependencies take precedence
 */
export function mergeDependencies(
  explicit: DependencyMap,
  inferred: DependencyMap
): DependencyMap {
  const merged: DependencyMap = {}
  
  const allTaskIds = new Set([
    ...Object.keys(explicit),
    ...Object.keys(inferred),
  ])
  
  for (const taskId of allTaskIds) {
    const explicitDeps = explicit[taskId] || []
    const inferredDeps = inferred[taskId] || []
    
    // Combine and deduplicate
    merged[taskId] = [...new Set([...explicitDeps, ...inferredDeps])]
  }
  
  return merged
}
