import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import { wroteTranscriptWithinActivityWindow } from '../agentdata/agent-present-state.ts';
import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { SubmitToAgentOptions } from '../herdr/herdr-send.types.ts';
import {
  shouldPageObservation,
  type BlockedPageLedgerEntry,
} from '../blocked-paging/blocked-agent-escalation-ledger.ts';
import type { NoIdlingDependencies, NoIdlingPageLedger } from './no-idling-dependencies.types.ts';
import { NO_IDLING_SENDER } from './no-idling-sender.ts';

export function inMemoryPageLedger(): NoIdlingPageLedger {
  const entries: BlockedPageLedgerEntry[] = [];
  return {
    read: async () => [...entries],
    append: async (entry) => {
      entries.push(entry);
    },
  };
}

export async function rosterOfPresentFacts(
  roster: readonly AgentStatusesRosterEntry[],
  deps: NoIdlingDependencies,
  dataDir: string,
  nowMs: number,
): Promise<AgentStatusesRosterEntry[]> {
  if (deps.readPresentState === undefined) return [...roster];
  const present: AgentStatusesRosterEntry[] = [];
  for (const entry of roster) {
    const state = await deps.readPresentState(entry.name, nowMs, dataDir);
    if (state.reaped) continue;
    const idleByPane = entry.lifecycle === 'live' && entry.liveStatus === 'idle';
    present.push(
      idleByPane && wroteTranscriptWithinActivityWindow(state, nowMs) ? { ...entry, liveStatus: 'working' } : entry,
    );
  }
  return present;
}

export async function submitUnlessAlreadyPaged(
  deps: NoIdlingDependencies,
  ledger: NoIdlingPageLedger,
  target: HerdrAgent,
  prompt: string,
  pageKey: string,
  options: SubmitToAgentOptions,
): Promise<boolean> {
  const nowMs = deps.now?.() ?? Date.now();
  if (!shouldPageObservation(pageKey, pageKey, nowMs, await ledger.read())) return false;
  await deps.submitToAgent(target, NO_IDLING_SENDER, prompt, {
    ...options,
    key: `${pageKey}:${Math.floor(nowMs / 60_000)}`,
  });
  await ledger.append({
    agentName: NO_IDLING_SENDER,
    observedAt: new Date(nowMs).toISOString(),
    kind: 'page-enqueued',
    pageKey,
    fingerprint: pageKey,
  });
  return true;
}
