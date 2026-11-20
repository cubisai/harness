import type { AutomationInput } from "./automations";
import type { McpServerSpec, McpServerStatus } from "./types";

export interface PluginCommand { name: string; description: string; prompt: string }
export interface PluginSkill { name: string; description: string; path: string }
export interface PluginConnector { name: string; spec: McpServerSpec }
export type PluginRuleTarget = { kind: "tool"; name: string } | { kind: "connector"; server: string; tool: string };
export interface PluginRule { action: "ask" | "allow"; target: PluginRuleTarget; reason?: string }
export interface PluginAutomation { name: string; input: AutomationInput }
export interface PluginContributions {
  appTheme?: import("./app-themes").PluginAppTheme;
  commands?: PluginCommand[];
  rules?: PluginRule[];
  skills?: PluginSkill[];
  connectors?: PluginConnector[];
  automations?: PluginAutomation[];
}
export interface PluginPartView {
  kind: "command" | "rule" | "skill" | "connector" | "automation" | "app-theme";
  name: string;
  description: string;
  detail?: string;
  risk?: boolean;
  projectId?: string;
  projectName?: string;
  change?: "added" | "changed" | "removed";
}
export interface PluginOwner { key: string; title: string; enabled: boolean; revision?: string }
export interface PluginSkillInvocation { key: string; name: string; revision: string }
export interface PluginCommandInvocation { key: string; name: string; revision: string }
export interface PluginCommandView extends PluginCommandInvocation { command: string; description: string }
export interface PluginConnectorHandle { key: string; name: string; revision: string }
/** Reviewed targets and value presence only; resolved credentials never leave main. */
export interface PluginConnectorView extends PluginConnectorHandle {
  runtimeName: string;
  owner: PluginOwner;
  type: McpServerSpec["type"];
  target: string;
  variables: { name: string; saved: boolean; missing: boolean }[];
  locked: boolean;
  hasClientSecret: boolean;
  canSignIn: boolean;
  canSetClientSecret: boolean;
  signingIn: boolean;
  status: McpServerStatus;
}

/** Qualified names cannot take any of the composer's built-in commands. */
export const pluginCommandName = (plugin: string, name: string): string => `${plugin}.${name}`;

/** The user event keeps the qualified command text; explicit prompt composition
 * receives only its arguments. Ordinary API callers may supply arguments alone. */
export function pluginCommandArguments(text: string, qualified: string): string {
  const trimmed = text.trim(), prefix = `/${qualified}`;
  return trimmed.startsWith(prefix) && (trimmed.length === prefix.length || /\s/.test(trimmed[prefix.length]!)) ? trimmed.slice(prefix.length).trim() : text;
}
