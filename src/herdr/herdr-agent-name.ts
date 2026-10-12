export function hasAgentName<Agent extends { readonly name?: string }>(
  agent: Agent,
): agent is Agent & { readonly name: string } {
  return agent.name !== undefined && agent.name.trim() !== '';
}
