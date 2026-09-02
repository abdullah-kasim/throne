export interface BlockedAgentPagingMessageParams {
  readonly agentName: string;
  readonly cwd?: string;
  readonly paneId: string;
  readonly title: string | null;
  readonly stateLabels: Readonly<Record<string, string>>;
}

/**
 * The Regent-facing page for BLOCKED-AND-STUCK evidence from either a pane
 * transition or the shared durable marker: names
 * the agent and every context field the subscription event or roster could
 * resolve, so the Regent can act without further digging.
 */
export function buildBlockedAgentPagingMessage(params: BlockedAgentPagingMessageParams): string {
  const context = [
    `pane: ${params.paneId}`,
    params.cwd ? `worktree: ${params.cwd}` : undefined,
    params.title ? `title: ${params.title}` : undefined,
    Object.keys(params.stateLabels).length > 0
      ? `state_labels: ${Object.entries(params.stateLabels)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join('; ');
  return (
    `${params.agentName} is blocked and is not a supervising ` +
    `Alpha with a live child (${context}). It is stuck, not merely waiting on a ` +
    `child -- inspect it and answer for it directly.`
  );
}
