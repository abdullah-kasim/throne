import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAgentState, type AgentState } from '../agentdata/agent-state.service.ts';
import type { BlockedAgentPagingDependencies } from './blocked-agent-paging-dependencies.types.ts';
import type { BlockedPageLedgerEntry } from './blocked-agent-escalation-ledger.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { HerdrAgent } from '../herdr/herdr-identity-contracts.ts';
import {
  readHarnessBackgroundWork,
  type HarnessBackgroundWorkHost,
} from '../process-inspection/harness-background-work.ts';
import { PROCESS_HOST_WITHOUT_HERDR } from '../process-inspection/harness-background-work-test-fixtures.ts';
import type { SupervisorWait } from '../supervisor-wait/read-supervisor-wait.ts';
import type { AgentPresentState } from '../agentdata/agent-present-state.ts';
import type { AgentStatus } from '../herdr/herdr-inventory.service.ts';
import type { RememberedOwnRunWait } from './own-run-wake.ts';
import { MessageQueueWorkItemState } from '../message-queue/message-queue-work-item-state.ts';

export type DeclaredState = Pick<AgentState, 'state' | 'declaredAt'> & Partial<AgentState>;

export function writeStateFile(stateFolder: string, agentName: string, declared: DeclaredState): void {
  const state: AgentState = {
    blockedBy: [],
    waitingOn: null,
    reapableReason: null,
    declaredBy: 'agent',
    ...declared,
    remindInMinutes: declared.remindInMinutes ?? 15,
  };
  mkdirSync(path.join(stateFolder, agentName), { recursive: true });
  writeFileSync(path.join(stateFolder, agentName, 'state.json'), `${JSON.stringify(state)}\n`);
}

export function fakeBlockedAgentPagingDependencies(fake: {
  readonly now: number;
  readonly roster: AgentStatusesRosterEntry[];
  readonly supervisorOf: (name: string) => string;
  readonly states?: Readonly<Record<string, DeclaredState>>;
  readonly stateFolder?: string;
  readonly processHostOfPane?: (paneId: string) => HarnessBackgroundWorkHost;
  readonly readSupervisorWait?: (agentName: string) => Promise<SupervisorWait>;
  readonly visiblePaneText?: (paneId: string) => string;
  readonly presentStateOf?: (agentName: string) => AgentPresentState;
  readonly herdrStatusOf?: (agentName: string) => AgentStatus;
}) {
  const rememberedOwnRunWaits = new Map<string, RememberedOwnRunWait>();
  const deliveryOutcomes = new Map<string, { state: string; failureReason: string | null }>();
  const pages: string[] = [];
  const recipients: string[] = [];
  const lordNotices: string[] = [];
  const folderTrustAcceptances: { agentName: string; optionNumber: number }[] = [];
  const escalationLedger: BlockedPageLedgerEntry[] = [];
  const stateFolder = fake.stateFolder ?? mkdtempSync(path.join(tmpdir(), 'blocked-paging-state-'));
  for (const [agentName, declared] of Object.entries(fake.states ?? {})) writeStateFile(stateFolder, agentName, declared);
  const declareState = (agentName: string, declared: DeclaredState) => writeStateFile(stateFolder, agentName, declared);
  const dependencies: BlockedAgentPagingDependencies = {
    herdrClient: {} as never,
    listKnownPaneIds: async () => [],
    getRoster: async () => fake.roster,
    readAgentSupervisor: async (name) => fake.supervisorOf(name),
    readAgentState: (name) => readAgentState(name, stateFolder),
    readHarnessBackgroundWork: (paneId) =>
      readHarnessBackgroundWork(paneId, fake.processHostOfPane?.(paneId) ?? PROCESS_HOST_WITHOUT_HERDR),
    readVisiblePaneText: async (paneId) => fake.visiblePaneText?.(paneId) ?? '',
    acceptFolderTrust: async (agentName, optionNumber) => {
      folderTrustAcceptances.push({ agentName, optionNumber });
    },
    resolveAgent: async (name) => ({ name, paneId: 'w1:p1', agentStatus: fake.herdrStatusOf?.(name) }) as HerdrAgent,
    readSupervisorWait:
      fake.readSupervisorWait ?? (async () => ({ waiting: false, reason: 'no supervisor wait in this fake' })),
    submitToAgent: async (target, _sender, prompt, options) => {
      if (options?.key !== undefined) deliveryOutcomes.set(options.key, { state: MessageQueueWorkItemState.Delivered, failureReason: null });
      pages.push(prompt);
      recipients.push(target.name ?? '');
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
    readPresentState: async (agentName) => fake.presentStateOf?.(agentName) ?? { reaped: false, withinSpawnGrace: false },
    readMessageDeliveryOutcome: async (key) => deliveryOutcomes.get(key),
    readRememberedOwnRunWait: async (agentName) => rememberedOwnRunWaits.get(agentName) ?? null,
    writeRememberedOwnRunWait: async (agentName, remembered) => {
      rememberedOwnRunWaits.set(agentName, remembered);
    },
    now: () => fake.now,
    stderr: () => undefined,
  };
  return { dependencies, deliveryOutcomes, pages, recipients, lordNotices, escalationLedger, stateFolder, declareState, folderTrustAcceptances };
}
