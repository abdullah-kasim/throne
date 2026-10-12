import { listTabs } from '../herdr/herdr-runtime.service.ts';
import type { HerdrTab } from '../herdr/herdr-inventory.service.ts';
import { hasAgentName } from '../herdr/herdr-agent-name.ts';
import {
  listLiveAgentStatuses,
  type LiveAgentStatus,
} from '../agent-statuses/agent-statuses-herdr.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { collectThroneLedgerNames } from './stale-tab-report.ts';

export interface UnnamedAgentReport {
  readonly paneId: string;
  readonly tabId: string;
  readonly tabLabel?: string;
  readonly cwd: string;
  readonly harness: string;
  readonly agentSessionId?: string;
  readonly likelyOwner?: string;
}

function unnamedAgentReport(
  agent: LiveAgentStatus,
  tabLabel: string | undefined,
  ledgerNames: ReadonlySet<string>,
): UnnamedAgentReport {
  return {
    paneId: agent.paneId,
    tabId: agent.tabId,
    ...(tabLabel === undefined ? {} : { tabLabel }),
    cwd: agent.cwd,
    harness: agent.agent,
    ...(agent.agentSessionId === undefined ? {} : { agentSessionId: agent.agentSessionId }),
    ...(tabLabel !== undefined && ledgerNames.has(tabLabel) ? { likelyOwner: tabLabel } : {}),
  };
}

export function findUnnamedAgents(
  liveAgents: readonly LiveAgentStatus[],
  tabs: readonly HerdrTab[],
  ledgerNames: ReadonlySet<string>,
): UnnamedAgentReport[] {
  const tabLabelsById = new Map(tabs.map((tab) => [tab.tabId, tab.label]));
  return liveAgents
    .filter((agent) => !hasAgentName(agent))
    .map((agent) => unnamedAgentReport(agent, tabLabelsById.get(agent.tabId), ledgerNames));
}

export async function detectUnnamedAgents(
  ledgerData: LedgerDataService = new LedgerDataService(),
  dataDir?: string,
): Promise<UnnamedAgentReport[]> {
  const [liveAgents, tabs, ledgerNames] = await Promise.all([
    listLiveAgentStatuses(),
    listTabs(),
    collectThroneLedgerNames(ledgerData, dataDir),
  ]);
  return findUnnamedAgents(liveAgents, tabs, ledgerNames);
}
