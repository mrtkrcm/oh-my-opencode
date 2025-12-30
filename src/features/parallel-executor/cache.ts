/**
 * Inference Cache - LRU Cache for Dependency Inference Results
 * 
 * Phase 2: Caches LLM inference results to avoid redundant API calls
 */

import type {
  Task,
  TaskId,
  DependencyMap,
  ConfidenceLevel,
  CacheEntry,
  CacheConfig,
} from "./types"
import { DEFAULT_CACHE_CONFIG } from "./types"
import { createHash } from "crypto"

/**
 * LRU Cache for dependency inference results
 */
export class InferenceCache {
  private cache: Map<string, CacheEntry> = new Map()
  private config: CacheConfig
  
  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config }
  }
  
  /**
   * Generate cache key from tasks
   * Uses content hash to handle task reordering
   */
  private generateKey(tasks: Task[]): string {
    // Sort tasks by content for consistent key
    const sortedContents = tasks
      .map(t => t.content.trim().toLowerCase())
      .sort()
      .join("|")
    
    return createHash("sha256")
      .update(sortedContents)
      .digest("hex")
      .slice(0, 16)
  }
  
  /**
   * Check if cache entry is valid (not expired)
   */
  private isValid(entry: CacheEntry): boolean {
    const age = Date.now() - entry.createdAt.getTime()
    return age < this.config.ttlMs
  }
  
  /**
   * Get cached inference result
   */
  get(tasks: Task[]): {
    dependencies: DependencyMap
    reasoning: Record<TaskId, string>
    confidence: ConfidenceLevel
  } | null {
    if (!this.config.enabled) return null
    
    const key = this.generateKey(tasks)
    const entry = this.cache.get(key)
    
    if (!entry || !this.isValid(entry)) {
      if (entry) {
        // Remove expired entry
        this.cache.delete(key)
      }
      return null
    }
    
    // Update hit count and move to end (LRU)
    entry.hitCount++
    this.cache.delete(key)
    this.cache.set(key, entry)
    
    // Remap task IDs if necessary (in case task IDs changed but content is same)
    const remappedDeps = this.remapDependencies(tasks, entry.dependencies)
    const remappedReasoning = this.remapReasoning(tasks, entry.reasoning)
    
    return {
      dependencies: remappedDeps,
      reasoning: remappedReasoning,
      confidence: entry.confidence,
    }
  }
  
  /**
   * Store inference result in cache
   */
  set(
    tasks: Task[],
    dependencies: DependencyMap,
    reasoning: Record<TaskId, string>,
    confidence: ConfidenceLevel
  ): void {
    if (!this.config.enabled) return
    
    const key = this.generateKey(tasks)
    
    // Evict if at capacity
    if (this.cache.size >= this.config.maxSize) {
      // Remove oldest entry (first in map)
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }
    
    const entry: CacheEntry = {
      key,
      dependencies,
      reasoning,
      confidence,
      createdAt: new Date(),
      hitCount: 0,
    }
    
    this.cache.set(key, entry)
  }
  
  /**
   * Remap dependencies from cached task IDs to current task IDs
   */
  private remapDependencies(tasks: Task[], cachedDeps: DependencyMap): DependencyMap {
    const contentToId = new Map<string, TaskId>()
    for (const task of tasks) {
      contentToId.set(task.content.trim().toLowerCase(), task.id)
    }
    
    const remapped: DependencyMap = {}
    
    // Build content map from cached dependencies
    const cachedIdToContent = new Map<TaskId, string>()
    for (const taskId of Object.keys(cachedDeps)) {
      // Try to find matching task
      for (const task of tasks) {
        if (task.id === taskId || task.content.trim().toLowerCase().includes(taskId)) {
          cachedIdToContent.set(taskId, task.content.trim().toLowerCase())
          break
        }
      }
    }
    
    // Remap each task's dependencies
    for (const task of tasks) {
      const cachedDepsForTask = cachedDeps[task.id] || []
      remapped[task.id] = cachedDepsForTask.filter(depId => 
        tasks.some(t => t.id === depId)
      )
    }
    
    return remapped
  }
  
  /**
   * Remap reasoning from cached task IDs to current task IDs
   */
  private remapReasoning(
    tasks: Task[],
    cachedReasoning: Record<TaskId, string>
  ): Record<TaskId, string> {
    const remapped: Record<TaskId, string> = {}
    
    for (const task of tasks) {
      remapped[task.id] = cachedReasoning[task.id] || "Cached result"
    }
    
    return remapped
  }
  
  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear()
  }
  
  /**
   * Get cache statistics
   */
  getStats(): {
    size: number
    maxSize: number
    hitCount: number
    enabled: boolean
  } {
    let totalHits = 0
    for (const entry of this.cache.values()) {
      totalHits += entry.hitCount
    }
    
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hitCount: totalHits,
      enabled: this.config.enabled,
    }
  }
  
  /**
   * Remove expired entries
   */
  prune(): number {
    let removed = 0
    
    for (const [key, entry] of this.cache) {
      if (!this.isValid(entry)) {
        this.cache.delete(key)
        removed++
      }
    }
    
    return removed
  }
}

/**
 * Create a cache key for a set of tasks (for external use)
 */
export function createTasksCacheKey(tasks: Task[]): string {
  const sortedContents = tasks
    .map(t => t.content.trim().toLowerCase())
    .sort()
    .join("|")
  
  return createHash("sha256")
    .update(sortedContents)
    .digest("hex")
    .slice(0, 16)
}
