import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import type { BlockedPageLedgerEntry } from './blocked-agent-escalation-ledger.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import {
  readHarnessBackgroundWork,
  type HarnessBackgroundWorkHost,
} from '../process-inspection/harness-background-work.ts';
import { PROCESS_HOST_WITHOUT_HERDR } from '../process-inspection/harness-background-work-test-fixtures.ts';

export interface StoredBlockedMarker {
  blockedAt: string;
  origin?: 'agent' | 'regent';
  blockedBy?: readonly string[];
}

export function fakeBlockedAgentPagingDependencies(fake: {
  readonly now: number;
  readonly roster: AgentStatusesRosterEntry[];
  readonly supervisorOf: (name: string) => string;
  readonly readAgent: (name: string) => Promise<string>;
  readonly blockedMarkers?: Map<string, StoredBlockedMarker>;
  readonly processHostOfPane?: (paneId: string) => HarnessBackgroundWorkHost;
}) {
  const pages: string[] = [];
  const lordNotices: string[] = [];
  const escalationLedger: BlockedPageLedgerEntry[] = [];
  const blockedMarkers = fake.blockedMarkers ?? new Map<string, StoredBlockedMarker>();
  const dependencies: BlockedAgentPagingDependencies = {
    herdrClient: {} as never,
    listKnownPaneIds: async () => [],
    getRoster: async () => fake.roster,
    readAgentSupervisor: async (name) => fake.supervisorOf(name),
    readAgent: fake.readAgent,
    readHarnessBackgroundWork: (paneId) =>
      readHarnessBackgroundWork(paneId, fake.processHostOfPane?.(paneId) ?? PROCESS_HOST_WITHOUT_HERDR),
    readVisiblePaneText: async () => '',
    blockedMarkerLedger: {
      readBlockedMarker: async (name) => blockedMarkers.get(name) ?? null,
      writeBlockedMarker: async (name, blockedBy) => {
        blockedMarkers.set(name, { blockedAt: new Date(fake.now).toISOString(), blockedBy });
      },
      clearBlockedMarker: async (name) => {
        blockedMarkers.delete(name);
      },
    },
    resolveAgent: async (name) => ({ name, paneId: 'w1:p1' }) as HerdrAgent,
    submitToAgent: async (_target, _sender, prompt) => {
      pages.push(prompt);
    },
    sleep: async () => undefined,
    readEscalationLedger: async () => escalationLedger,
    appendEscalationLedger: async (entry) => {
      escalationLedger.push(entry);
    },
    notifyLord: async (message) => {
      lordNotices.push(message);
      return true;
    },
    now: () => fake.now,
    stderr: () => undefined,
  };
  return { dependencies, pages, lordNotices, escalationLedger, blockedMarkers };
}
