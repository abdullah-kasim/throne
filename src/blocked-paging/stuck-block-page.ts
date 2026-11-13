import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import type { PaneAgentStatusChangedEvent } from './pane-agent-status-subscription.ts';
import { buildBlockedAgentPagingMessage } from './blocked-agent-paging-message.ts';
import { shouldPageObservation } from './blocked-agent-escalation-ledger.ts';
import { pageRegentWithinEscalationBound } from './blocked-agent-regent-page.ts';
import {
  CLAUDE_FOLDER_TRUST_ACCEPT_LABEL,
  detectInteractivePrompt,
  INTERACTIVE_PROMPT_KINDS,
  type DetectedInteractivePrompt,
} from '../pane-prompts/detect-interactive-prompt.ts';
import { isCourtCampaignWorktree } from '../claude-spawn-trust/claude-worktree-trust.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';

function blockedAgentPageKey(agentName: string): string {
  return `blocked-agent-paging:${agentName}`;
}

function blockedStateFingerprint(
  marker: Awaited<ReturnType<BlockedAgentPagingDependencies['blockedMarkerLedger']['readBlockedMarker']>>,
  prompt: DetectedInteractivePrompt | undefined,
): string {
  return JSON.stringify({ blockedAt: marker?.blockedAt ?? null, prompt: prompt ?? null });
}

function courtTrustAcceptanceFor(prompt: DetectedInteractivePrompt | undefined): number | undefined {
  if (
    prompt?.kind !== INTERACTIVE_PROMPT_KINDS.FOLDER_TRUST ||
    prompt.folder === undefined ||
    !isCourtCampaignWorktree(prompt.folder)
  ) {
    return undefined;
  }
  return prompt.options.find((option) => option.label === CLAUDE_FOLDER_TRUST_ACCEPT_LABEL)?.number;
}

export async function pageRegentForStuckBlock(
  agentName: string,
  event: PaneAgentStatusChangedEvent,
  roster: readonly AgentStatusesRosterEntry[],
  deps: BlockedAgentPagingDependencies,
): Promise<void> {
  const rosterEntry = roster.find((entry) => sameAgentName(entry.name, agentName));
  const prompt = detectInteractivePrompt(await deps.readVisiblePaneText(event.paneId));
  const trustAcceptance = courtTrustAcceptanceFor(prompt);
  if (trustAcceptance !== undefined) {
    await deps.acceptFolderTrust(agentName, trustAcceptance);
    return;
  }
  const pageKey = blockedAgentPageKey(agentName);
  const fingerprint = blockedStateFingerprint(await deps.blockedMarkerLedger.readBlockedMarker(agentName), prompt);
  if (!shouldPageObservation(pageKey, fingerprint, deps.now?.() ?? Date.now(), await deps.readEscalationLedger())) {
    return;
  }
  await pageRegentWithinEscalationBound(
    agentName,
    pageKey,
    async () =>
      buildBlockedAgentPagingMessage({
        agentName,
        cwd: rosterEntry?.cwd,
        paneId: event.paneId,
        title: event.title,
        stateLabels: event.stateLabels,
        prompt,
      }),
    deps,
    fingerprint,
  );
}

