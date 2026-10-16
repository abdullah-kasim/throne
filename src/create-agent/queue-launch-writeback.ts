import { agentRegistrationExists } from "../agentdata/spawn-data-contracts.ts";
import { TREE_BASE_DATA } from "../agentdata/tree-base-data.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { listAgents } from "../herdr/herdr-runtime.service.ts";
import { recordAgentLaunchOnQueueItem } from "../regent-queue/regent-queue-lifecycle.ts";
import {
  openRegentQueueStore,
  type RegentQueueStore,
} from "../regent-queue/regent-queue.store.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";

export interface QueueLaunchWritebackDeps {
  openStore?: () => RegentQueueStore;
  readTreeBase?: typeof TREE_BASE_DATA.read;
  writeStdout?: (text: string) => void;
  listAgents?: typeof listAgents;
  ledgerBaseDir?: string;
}

async function reasonAgentCannotTakeTheRow(
  name: string,
  deps: Pick<QueueLaunchWritebackDeps, "listAgents" | "ledgerBaseDir">,
): Promise<string | undefined> {
  if (!(await agentRegistrationExists(name, deps.ledgerBaseDir))) {
    return "its ledger is gone, so it was reaped during its own launch";
  }
  if (await herdrNoLongerListsTheAgent(name, deps)) {
    return "it is no longer registered in herdr, so it was reaped during its own launch";
  }
  return undefined;
}

async function herdrNoLongerListsTheAgent(
  name: string,
  deps: Pick<QueueLaunchWritebackDeps, "listAgents">,
): Promise<boolean> {
  let agents;
  try {
    agents = await (deps.listAgents ?? listAgents)();
  } catch {
    return false;
  }
  return !agents.some((agent) => sameAgentName(agent.name, name));
}

/**
 * `create-agent`'s side of the shared queue lifecycle write-back
 * (`regent-queue-lifecycle.ts`): a successful launch against a campaign
 * objective code transitions its matched queue item to `in-flight`,
 * recording the agent name, target repo, and base commit from the tree this
 * campaign was just prepared against. A non-campaign launch (no objective
 * code) is a no-op — there is nothing to look up. Never throws: any failure
 * to match, open the store, or read the tree is logged to stdout and
 * swallowed, so the write-back can never fail the launch it rides along
 * with.
 */
export async function writeQueueLaunchLinkage(
  name: string,
  objectiveContract: ObjectiveContract | undefined,
  deps: QueueLaunchWritebackDeps = {},
): Promise<void> {
  if (objectiveContract === undefined || objectiveContract.kind !== "campaign") {
    return;
  }
  const openStore = deps.openStore ?? openRegentQueueStore;
  const readTreeBase = deps.readTreeBase ?? TREE_BASE_DATA.read.bind(TREE_BASE_DATA);
  const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
  let store: RegentQueueStore | undefined;
  try {
    const refusal = await reasonAgentCannotTakeTheRow(name, deps);
    if (refusal !== undefined) {
      writeStdout(
        `create-agent: queue linkage not recorded for "${name}" — ${refusal}.\n`,
      );
      return;
    }
    const tree = await readTreeBase(name);
    store = openStore();
    const outcome = recordAgentLaunchOnQueueItem(store, {
      objectiveCode: objectiveContract.objectiveCode,
      agentName: name,
      targetRepo: tree?.repo,
      baseCommit: tree?.commit,
    });
    if (!outcome.matched) {
      writeStdout(
        `create-agent: queue linkage not recorded for "${name}" — ${outcome.reason}.\n`,
      );
    }
  } catch (error) {
    writeStdout(
      `create-agent: queue linkage write-back failed for "${name}" (${error instanceof Error ? error.message : String(error)}) — launch proceeds unaffected.\n`,
    );
  } finally {
    store?.close();
  }
}
