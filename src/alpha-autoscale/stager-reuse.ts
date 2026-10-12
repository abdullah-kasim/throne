import type { HerdrTab } from "../herdr/herdr-inventory.service.ts";
import { exactLabelTabs } from "../herdr/herdr-restored-tab-inspection.ts";
import { listAgents, listTabs } from "../herdr/herdr-runtime.service.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { fastForwardTreeToMainWhenOnlyBehind } from "../stager-tree-refresh/stager-tree-refresh.ts";
import {
  REAL_RESUME_CONTRACT,
  extractLiveNames,
  resumeOrphan,
  type StartupResumeContract,
} from "../throne-startup/throne-startup-reconciliation.service.ts";
import {
  REAL_REUSABLE_STAGER_EVIDENCE,
  findStagerTheCourtWouldReuse,
  type ReusableStager,
  type ReusableStagerEvidence,
} from "./reusable-stager.ts";

export const STAGER_REUSE_OUTCOMES = {
  REUSED: "reused",
  NONE_REUSABLE: "none-reusable",
} as const;

export type StagerReuseOutcome =
  | ({ readonly kind: typeof STAGER_REUSE_OUTCOMES.REUSED } & ReusableStager)
  | { readonly kind: typeof STAGER_REUSE_OUTCOMES.NONE_REUSABLE };

export interface StagerReuseEffects {
  readonly evidence: ReusableStagerEvidence;
  readonly listLiveAgentNames: () => Promise<string[]>;
  readonly listTabs: () => Promise<HerdrTab[]>;
  readonly findRestoredAgentTab: (
    label: string,
  ) => Promise<{ readonly tabId: string; readonly paneId: string } | null>;
  readonly fastForwardWorktreeToMain: (worktree: string) => Promise<unknown>;
  readonly resume: StartupResumeContract;
  readonly log: (message: string) => void;
}

export const REAL_STAGER_REUSE_EFFECTS: Omit<
  StagerReuseEffects,
  "findRestoredAgentTab"
> = {
  evidence: REAL_REUSABLE_STAGER_EVIDENCE,
  listLiveAgentNames: async () => extractLiveNames(await listAgents()),
  listTabs,
  fastForwardWorktreeToMain: (worktree) =>
    fastForwardTreeToMainWhenOnlyBehind(worktree),
  resume: REAL_RESUME_CONTRACT,
  log: (message) => console.log(`[stager-reuse] ${message}`),
};

const NONE_REUSABLE: StagerReuseOutcome = {
  kind: STAGER_REUSE_OUTCOMES.NONE_REUSABLE,
};

async function nameIsCarriedByATabThatCannotBeReused(
  name: string,
  effects: StagerReuseEffects,
): Promise<boolean> {
  if ((await effects.findRestoredAgentTab(name)) !== null) return false;
  return exactLabelTabs(await effects.listTabs(), name).length > 0;
}

function startingAFreshSession(
  contract: StartupResumeContract,
): StartupResumeContract {
  return {
    ...contract,
    readSpawnSpec: async (name) => {
      const spawnSpec = await contract.readSpawnSpec(name);
      return spawnSpec === null ? null : { ...spawnSpec, session_id: undefined };
    },
  };
}

async function resumeRecordedSessionOrStartFresh(
  name: string,
  effects: StagerReuseEffects,
): Promise<void> {
  try {
    await resumeOrphan(name, effects.resume);
  } catch (error) {
    effects.log(
      `"${name}" could not be brought back in its recorded session (${errorText(error)}); starting a fresh session under the same name and worktree`,
    );
    await resumeOrphan(name, startingAFreshSession(effects.resume));
  }
}

export async function reuseRegisteredStager(
  effects: StagerReuseEffects,
): Promise<StagerReuseOutcome> {
  const stager = await findStagerTheCourtWouldReuse(
    await effects.listLiveAgentNames(),
    effects.evidence,
  );
  if (stager === null) return NONE_REUSABLE;
  if (await nameIsCarriedByATabThatCannotBeReused(stager.name, effects)) {
    effects.log(
      `"${stager.name}" is not brought back: a tab already carries its name and cannot be reused`,
    );
    return NONE_REUSABLE;
  }
  await effects.fastForwardWorktreeToMain(stager.worktree);
  await resumeRecordedSessionOrStartFresh(stager.name, effects);
  effects.log(`brought back "${stager.name}" in ${stager.worktree}`);
  return { kind: STAGER_REUSE_OUTCOMES.REUSED, ...stager };
}
