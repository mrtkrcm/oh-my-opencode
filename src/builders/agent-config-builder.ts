/**
 * AgentConfigBuilder - Fluent builder for complex agent configuration merging.
 *
 * Consolidates the 80+ lines of agent config logic from index.ts into a
 * readable, testable, and maintainable builder pattern.
 */

import { PLAN_SYSTEM_PROMPT, PLAN_PERMISSION } from "../agents/plan-prompt";

// Use a permissive type to avoid conflicts with SDK's AgentConfig
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AgentConfig = Record<string, any>;

export interface SisyphusConfig {
  disabled?: boolean;
  default_builder_enabled?: boolean;
  planner_enabled?: boolean;
  replace_plan?: boolean;
}

export interface BaseAgentConfigs {
  build?: AgentConfig & { name?: string };
  plan?: AgentConfig & { name?: string };
  [key: string]: AgentConfig | undefined;
}

interface AgentSources {
  builtin: Record<string, AgentConfig>;
  user: Record<string, AgentConfig>;
  project: Record<string, AgentConfig>;
  plugin: Record<string, AgentConfig>;
  base: BaseAgentConfigs;
}

interface ToolRestriction {
  agentName: string;
  disabledTools: string[];
}

const DEFAULT_TOOL_RESTRICTIONS: ToolRestriction[] = [
  { agentName: "explore", disabledTools: ["call_omo_agent"] },
  { agentName: "librarian", disabledTools: ["call_omo_agent"] },
  { agentName: "multimodal-looker", disabledTools: ["task", "call_omo_agent", "look_at"] },
];

export class AgentConfigBuilder {
  private sources: AgentSources = {
    builtin: {},
    user: {},
    project: {},
    plugin: {},
    base: {},
  };

  private sisyphusConfig: SisyphusConfig = {
    disabled: false,
    default_builder_enabled: false,
    planner_enabled: true,
    replace_plan: true,
  };

  private agentOverrides: Record<string, AgentConfig> = {};
  private toolRestrictions: ToolRestriction[] = [...DEFAULT_TOOL_RESTRICTIONS];
  private defaultAgent: string | undefined;

  /**
   * Set builtin agents from createBuiltinAgents()
   */
  withBuiltinAgents(agents: Record<string, AgentConfig>): this {
    this.sources.builtin = agents;
    return this;
  }

  /**
   * Set user-defined agents from ~/.config/opencode/agents/
   */
  withUserAgents(agents: Record<string, AgentConfig>): this {
    this.sources.user = agents;
    return this;
  }

  /**
   * Set project-defined agents from .opencode/agents/
   */
  withProjectAgents(agents: Record<string, AgentConfig>): this {
    this.sources.project = agents;
    return this;
  }

  /**
   * Set plugin-provided agents
   */
  withPluginAgents(agents: Record<string, AgentConfig>): this {
    this.sources.plugin = agents;
    return this;
  }

  /**
   * Set base config.agent from OpenCode
   */
  withBaseAgents(agents: BaseAgentConfigs): this {
    this.sources.base = agents;
    return this;
  }

  /**
   * Configure Sisyphus orchestrator behavior
   */
  withSisyphusConfig(config: SisyphusConfig): this {
    this.sisyphusConfig = { ...this.sisyphusConfig, ...config };
    return this;
  }

  /**
   * Add agent-specific overrides from pluginConfig.agents
   */
  withAgentOverrides(overrides: Record<string, AgentConfig>): this {
    this.agentOverrides = overrides;
    return this;
  }

  /**
   * Add custom tool restrictions for specific agents
   */
  withToolRestriction(agentName: string, disabledTools: string[]): this {
    this.toolRestrictions.push({ agentName, disabledTools });
    return this;
  }

  /**
   * Build the final merged agent configuration
   */
  build(): { agents: Record<string, AgentConfig>; defaultAgent?: string } {
    const isSisyphusEnabled = !this.sisyphusConfig.disabled && !!this.sources.builtin.Sisyphus;

    let agents: Record<string, AgentConfig>;

    if (isSisyphusEnabled) {
      agents = this.buildWithSisyphus();
      this.defaultAgent = "Sisyphus";
    } else {
      agents = this.buildWithoutSisyphus();
    }

    // Apply tool restrictions
    this.applyToolRestrictions(agents);

    return { agents, defaultAgent: this.defaultAgent };
  }

  private buildWithSisyphus(): Record<string, AgentConfig> {
    const { builtin, user, project, plugin, base } = this.sources;
    const { default_builder_enabled, planner_enabled, replace_plan } = this.sisyphusConfig;

    const result: Record<string, AgentConfig> = {
      Sisyphus: builtin.Sisyphus,
    };

    // Add OpenCode-Builder if enabled
    if (default_builder_enabled) {
      result["OpenCode-Builder"] = this.createOpenCodeBuilder();
    }

    // Add Planner-Sisyphus if enabled
    if (planner_enabled) {
      result["Planner-Sisyphus"] = this.createPlannerSisyphus();
    }

    // Add other builtins (excluding Sisyphus which is already added)
    for (const [name, config] of Object.entries(builtin)) {
      if (name !== "Sisyphus") {
        result[name] = config;
      }
    }

    // Layer in other sources
    Object.assign(result, user, project, plugin);

    // Add filtered base agents (excluding build, and plan if replaced)
    for (const [name, config] of Object.entries(base)) {
      if (name === "build") continue;
      if (name === "plan" && replace_plan) continue;
      if (config) {
        result[name] = config;
      }
    }

    // Demote build/plan to subagent mode
    if (base.build) {
      result.build = { ...base.build, mode: "subagent" };
    }
    if (replace_plan && base.plan) {
      result.plan = { ...base.plan, mode: "subagent" };
    }

    return result;
  }

  private buildWithoutSisyphus(): Record<string, AgentConfig> {
    const { builtin, user, project, plugin, base } = this.sources;

    // Filter out undefined values from base
    const filteredBase: Record<string, AgentConfig> = {};
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) {
        filteredBase[key] = value;
      }
    }

    return {
      ...builtin,
      ...user,
      ...project,
      ...plugin,
      ...filteredBase,
    };
  }

  private createOpenCodeBuilder(): AgentConfig {
    const baseConfig = this.sources.base.build;
    const override = this.agentOverrides["OpenCode-Builder"];

    // Remove 'name' from base config
    const { name: _name, ...configWithoutName } = baseConfig ?? {};

    const result: AgentConfig = {
      ...configWithoutName,
      description: `${baseConfig?.description ?? "Build agent"} (OpenCode default)`,
    };

    return override ? { ...result, ...override } : result;
  }

  private createPlannerSisyphus(): AgentConfig {
    const baseConfig = this.sources.base.plan;
    const override = this.agentOverrides["Planner-Sisyphus"];

    // Remove 'name' from base config
    const { name: _name, ...configWithoutName } = baseConfig ?? {};

    const result: AgentConfig = {
      ...configWithoutName,
      prompt: PLAN_SYSTEM_PROMPT,
      permission: PLAN_PERMISSION,
      description: `${baseConfig?.description ?? "Plan agent"} (OhMyOpenCode version)`,
      color: baseConfig?.color ?? "#6495ED",
    };

    return override ? { ...result, ...override } : result;
  }

  private applyToolRestrictions(agents: Record<string, AgentConfig>): void {
    for (const { agentName, disabledTools } of this.toolRestrictions) {
      const agent = agents[agentName];
      if (agent) {
        agent.tools = {
          ...agent.tools,
          ...Object.fromEntries(disabledTools.map(tool => [tool, false])),
        };
      }
    }
  }
}

/**
 * Factory function for creating a pre-configured builder
 */
export function createAgentConfigBuilder(): AgentConfigBuilder {
  return new AgentConfigBuilder();
}
