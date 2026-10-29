/** The key a thread's session with `agent` is stored under. One instance per agent for now. */
export function bindingKey(agent: string, instanceId = "default"): string {
  return `${agent}:${instanceId}`;
}
