/**
 * Async config loader with mtime-based caching.
 *
 * Reduces disk I/O by caching parsed configs and only reloading when files change.
 * Uses fs.promises for non-blocking file operations.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { OhMyOpenCodeConfigSchema, type OhMyOpenCodeConfig } from "../config";
import { parseJsonc, detectConfigFile, getUserConfigDir, deepMerge, log, addConfigLoadError } from "../shared";

interface CachedConfig {
  mtime: number;
  config: OhMyOpenCodeConfig | null;
}

// Module-level cache: path -> { mtime, config }
const configCache = new Map<string, CachedConfig>();

/**
 * Get file mtime, or null if file doesn't exist
 */
async function getFileMtime(filePath: string): Promise<number | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Load and parse config file with caching
 */
async function loadConfigFromPathAsync(
  configPath: string,
  migrateConfigFile?: (path: string, config: Record<string, unknown>) => void
): Promise<OhMyOpenCodeConfig | null> {
  const mtime = await getFileMtime(configPath);

  if (mtime === null) {
    // File doesn't exist, clear any cached value
    configCache.delete(configPath);
    return null;
  }

  // Check cache
  const cached = configCache.get(configPath);
  if (cached && cached.mtime === mtime) {
    return cached.config;
  }

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const rawConfig = parseJsonc<Record<string, unknown>>(content);

    // Run migration if provided
    if (migrateConfigFile) {
      migrateConfigFile(configPath, rawConfig);
    }

    const result = OhMyOpenCodeConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      const errorMsg = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      log(`Config validation error in ${configPath}:`, result.error.issues);
      addConfigLoadError({ path: configPath, error: `Validation error: ${errorMsg}` });
      configCache.set(configPath, { mtime, config: null });
      return null;
    }

    log(`Config loaded from ${configPath}`, { agents: result.data.agents });
    configCache.set(configPath, { mtime, config: result.data });
    return result.data;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log(`Error loading config from ${configPath}:`, err);
    addConfigLoadError({ path: configPath, error: errorMsg });
    configCache.set(configPath, { mtime, config: null });
    return null;
  }
}

/**
 * Merge two configs with proper array deduplication
 */
function mergeConfigs(
  base: OhMyOpenCodeConfig,
  override: OhMyOpenCodeConfig
): OhMyOpenCodeConfig {
  return {
    ...base,
    ...override,
    agents: deepMerge(base.agents, override.agents),
    disabled_agents: [
      ...new Set([
        ...(base.disabled_agents ?? []),
        ...(override.disabled_agents ?? []),
      ]),
    ],
    disabled_mcps: [
      ...new Set([
        ...(base.disabled_mcps ?? []),
        ...(override.disabled_mcps ?? []),
      ]),
    ],
    disabled_hooks: [
      ...new Set([
        ...(base.disabled_hooks ?? []),
        ...(override.disabled_hooks ?? []),
      ]),
    ],
    disabled_commands: [
      ...new Set([
        ...(base.disabled_commands ?? []),
        ...(override.disabled_commands ?? []),
      ]),
    ],
    claude_code: deepMerge(base.claude_code, override.claude_code),
  };
}

export interface AsyncConfigLoaderOptions {
  migrateConfigFile?: (path: string, config: Record<string, unknown>) => void;
}

/**
 * Async config loader with caching
 */
export async function loadPluginConfigAsync(
  directory: string,
  options?: AsyncConfigLoaderOptions
): Promise<OhMyOpenCodeConfig> {
  // User-level config path (OS-specific) - prefer .jsonc over .json
  const userBasePath = path.join(getUserConfigDir(), "opencode", "oh-my-opencode");
  const userDetected = detectConfigFile(userBasePath);
  const userConfigPath = userDetected.format !== "none" ? userDetected.path : userBasePath + ".json";

  // Project-level config path - prefer .jsonc over .json
  const projectBasePath = path.join(directory, ".opencode", "oh-my-opencode");
  const projectDetected = detectConfigFile(projectBasePath);
  const projectConfigPath = projectDetected.format !== "none" ? projectDetected.path : projectBasePath + ".json";

  // Load both configs in parallel
  const [userConfig, projectConfig] = await Promise.all([
    loadConfigFromPathAsync(userConfigPath, options?.migrateConfigFile),
    loadConfigFromPathAsync(projectConfigPath, options?.migrateConfigFile),
  ]);

  // Merge configs
  let config: OhMyOpenCodeConfig = userConfig ?? {};
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig);
  }

  log("Final merged config", {
    agents: config.agents,
    disabled_agents: config.disabled_agents,
    disabled_mcps: config.disabled_mcps,
    disabled_hooks: config.disabled_hooks,
    claude_code: config.claude_code,
  });

  return config;
}

/**
 * Clear the config cache (useful for testing or force reload)
 */
export function clearConfigCache(): void {
  configCache.clear();
}

/**
 * Check if a config path is cached and still valid
 */
export function isConfigCached(configPath: string): boolean {
  return configCache.has(configPath);
}

/**
 * Get cache stats for debugging
 */
export function getConfigCacheStats(): { size: number; paths: string[] } {
  return {
    size: configCache.size,
    paths: Array.from(configCache.keys()),
  };
}
