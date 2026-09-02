// The `BlockedAgentPagingDependencies` type on its own, with no imports back
// into blocked-agent-paging.hosted-worker.ts -- mirrors
// `no-idling-dependencies.types.ts`'s split for the same acyclicity reason.
import type { HerdrClientService } from '../herdr/herdr-client.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { SubmitToAgentOptions } from '../herdr/herdr-send.types.ts';
import type { BlockedPageLedgerEntry } from './blocked-agent-escalation-ledger.ts';
import type { BlockedMarkerLedger } from '../no-idling/idle-family.ts';

export interface BlockedAgentPagingDependencies {
  readonly herdrClient: HerdrClientService;
  /** Panes to open the `pane.agent_status_changed` subscription for -- see
   *  `PaneAgentStatusSubscriptionDependencies.listKnownPaneIds`. */
  readonly listKnownPaneIds: () => Promise<readonly string[]>;
  readonly getRoster: (dataDir: string) => Promise<AgentStatusesRosterEntry[]>;
  readonly readAgentSupervisor: (name: string, dataDir: string) => Promise<string>;
  readonly readAgent: (name: string) => Promise<string>;
  readonly blockedMarkerLedger: BlockedMarkerLedger;
  readonly resolveAgent: (name: string) => Promise<HerdrAgent>;
  readonly submitToAgent: (
    target: HerdrAgent,
    sender: string,
    prompt: string,
    options?: SubmitToAgentOptions,
  ) => Promise<void>;
  /** Waits out the confirmation window between a first `blocked` observation
   *  and the fresh re-check that decides whether it pages. */
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readEscalationLedger: () => Promise<BlockedPageLedgerEntry[]>;
  readonly appendEscalationLedger: (entry: BlockedPageLedgerEntry) => Promise<void>;
  readonly notifyLord: (message: string) => Promise<boolean>;
  readonly now?: () => number;
  readonly stderr?: (text: string) => void;
}
