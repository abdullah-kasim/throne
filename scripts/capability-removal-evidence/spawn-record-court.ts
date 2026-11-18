import { readSpawnSpec } from "../../src/agentdata/spawn-data-contracts.ts";
import { LedgerDataService } from "../../src/agentdata/ledger-data.service.ts";
import {
  REAL_RESUME_CONTRACT,
  resumeOrphan,
  ThroneStartupReconciliationService,
  type StartupReconciliationContract,
} from "../../src/throne-startup/throne-startup-reconciliation.service.ts";

const names = process.argv.slice(2);
const warnings: string[] = [];
const ledger = new LedgerDataService();

async function resumeLaunchOf(name: string): Promise<unknown> {
  let launch: unknown = null;
  await resumeOrphan(name, {
    ...REAL_RESUME_CONTRACT,
    pathExists: async () => true,
    resumeRegisteredAgentInRestoredTab: (async (_name: string, options: unknown) => {
      launch = options;
      return { kind: "launched" };
    }) as unknown as typeof REAL_RESUME_CONTRACT.resumeRegisteredAgentInRestoredTab,
    deliverOpeningPrompt: (async () => {}) as unknown as typeof REAL_RESUME_CONTRACT.deliverOpeningPrompt,
    log: () => {},
    warn: () => {},
  });
  return launch;
}

const records = await Promise.all(names.map(async (name) => ({ name, loaded: (await readSpawnSpec(name)) !== null, resume: await resumeLaunchOf(name) })));

const actions: string[] = [];
const contract: StartupReconciliationContract = {
  listRegisteredAgents: () => ledger.listRegisteredAgents(),
  listCompletedAgents: () => ledger.listCompletedAgents(),
  hasResumableWork: (name) => ledger.hasResumableWork(name),
  hasDeliveryCommit: async () => false,
  listLiveAgents: async () => [],
  readSpawnSpec: (name) => readSpawnSpec(name),
  resume: async (name) => {
    actions.push(`resume ${name}`);
  },
  reap: async (name) => {
    actions.push(`reap ${name}`);
  },
  readAgentState: async () => ({ state: "working" }),
  clearBlockedState: async () => {},
  pathExists: async () => true,
  findStagerTheCourtWouldReuse: async () => null,
  harnessProvenance: async () => {
    throw new Error("no pane in this court");
  },
  currentPaneId: async () => undefined,
  stopHarnessInPane: async () => {},
  ensurePaneCarriesName: async () => undefined,
  log: () => {},
  warn: (message) => {
    warnings.push(message);
  },
};
const outcomes = await new ThroneStartupReconciliationService(contract).reconcile([]);

process.stdout.write(JSON.stringify({ records, reconciliation: { outcomes, actions, warnings } }));
