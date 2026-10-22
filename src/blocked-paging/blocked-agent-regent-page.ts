import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import {
  blockedPageEscalationState,
  BLOCKED_PAGE_ESCALATION_BOUND,
  hasBlockedPageCredit,
} from './blocked-agent-escalation-ledger.ts';
import { NO_IDLING_REGENT_NAME } from '../no-idling/idle-family.ts';
import { NO_IDLING_SUBMIT_TIMEOUT_MS } from '../no-idling/no-idling-run.ts';

export const BLOCKED_AGENT_PAGING_SENDER = 'blocked-paging';

export async function submitPageToRegent(
  message: string,
  pageKey: string,
  deps: Pick<BlockedAgentPagingDependencies, 'resolveAgent' | 'submitToAgent'>,
): Promise<void> {
  const regent = await deps.resolveAgent(NO_IDLING_REGENT_NAME);
  await deps.submitToAgent(regent, BLOCKED_AGENT_PAGING_SENDER, message, {
    key: pageKey,
    composerWaitMilliseconds: NO_IDLING_SUBMIT_TIMEOUT_MS,
  });
}

export async function pageRegentWithinEscalationBound(
  agentName: string,
  pageKey: string,
  buildMessage: () => Promise<string>,
  deps: BlockedAgentPagingDependencies,
): Promise<void> {
  const priorState = blockedPageEscalationState(agentName, await deps.readEscalationLedger());
  if (priorState.pageCount >= BLOCKED_PAGE_ESCALATION_BOUND) {
    if (!priorState.lordNotified) {
      await notifyLordOfBoundedBlockedEscalation(agentName, priorState.pageCount, deps);
    }
    return;
  }
  await submitPageToRegent(await buildMessage(), pageKey, deps);
  const observedAt = new Date(deps.now?.() ?? Date.now()).toISOString();
  const entriesAfterEnqueue = await deps.readEscalationLedger();
  if (!hasBlockedPageCredit(agentName, pageKey, entriesAfterEnqueue)) {
    await deps.appendEscalationLedger({ agentName, observedAt, kind: 'page-enqueued', pageKey });
  }
  const state = blockedPageEscalationState(agentName, await deps.readEscalationLedger());
  if (state.pageCount >= BLOCKED_PAGE_ESCALATION_BOUND && !state.lordNotified) {
    await notifyLordOfBoundedBlockedEscalation(agentName, state.pageCount, deps, observedAt);
  }
}

async function notifyLordOfBoundedBlockedEscalation(
  agentName: string,
  pageCount: number,
  deps: BlockedAgentPagingDependencies,
  observedAt = new Date(deps.now?.() ?? Date.now()).toISOString(),
): Promise<void> {
  const delivered = await deps.notifyLord(
    `${agentName} remains blocked after ${pageCount} Regent pages; inspect the durable blocked-agent paging ledger.`,
  );
  if (delivered) {
    await deps.appendEscalationLedger({ agentName, observedAt, kind: 'lord-notified' });
  }
}
