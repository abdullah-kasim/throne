import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { classifyLastMessageTags, lastMessageBlock, resolveBlockedTag } from '../no-idling/idle-family.ts';
import { NO_IDLING_SUBMIT_TIMEOUT_MS } from '../no-idling/no-idling-run.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import { buildSupervisorWaitPagingMessage } from './blocked-agent-paging-message.ts';
import { BLOCKED_AGENT_PAGING_SENDER } from './blocked-agent-regent-page.ts';

export async function pageSupervisorWhenShadowWaitsOnIt(
  agentName: string,
  paneId: string,
  roster: readonly AgentStatusesRosterEntry[],
  deps: BlockedAgentPagingDependencies,
): Promise<boolean> {
  const entry = roster.find((candidate) => sameAgentName(candidate.name, agentName));
  if (entry?.role !== 'Shadow') return false;
  const paneText = await deps.readAgent(agentName).catch(() => undefined);
  if (paneText === undefined) return false;
  const wait = await deps.readSupervisorWait(agentName, paneText);
  if (!wait.waiting) return false;
  const tag = await resolveBlockedTag(
    agentName,
    async () => classifyLastMessageTags(lastMessageBlock(paneText)),
    deps.blockedMarkerLedger,
  );
  if (tag.kind !== 'blocked' || !tag.blockedBy.some((name) => sameAgentName(name, wait.supervisor))) {
    return false;
  }
  const pageKey = `blocked-agent-paging:supervisor-wait:${agentName}:${wait.step}`;
  const ledger = await deps.readEscalationLedger();
  if (ledger.some((record) => record.agentName === agentName && record.pageKey === pageKey)) return true;
  await deps.submitToAgent(
    await deps.resolveAgent(wait.supervisor),
    BLOCKED_AGENT_PAGING_SENDER,
    buildSupervisorWaitPagingMessage({ agentName, cwd: entry.cwd, paneId, step: wait.step }),
    { key: pageKey, composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS },
  );
  await deps.appendEscalationLedger({
    agentName,
    observedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    kind: 'supervisor-paged',
    pageKey,
  });
  return true;
}
