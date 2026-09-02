import { listPanes, listTabs, readVisibleAnsi } from '../herdr/herdr-runtime.service.ts';
import type { HerdrPane, HerdrTab } from '../herdr/herdr-inventory.service.ts';
import {
  listLiveAgentStatuses,
  type LiveAgentStatus,
} from '../agent-statuses/agent-statuses-herdr.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { openingPromptPath } from '../agentdata/identity-data.service.ts';
import { fileExists, readSpawnSpec } from '../agentdata/spawn-data-contracts.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { spawnedAtAgeMs } from './idle-family.ts';
import {
  classifyStrandedSpawnPane,
  type StrandedSpawnClassification,
} from './stranded-spawn-classification.ts';

/**
 * Fixed throne tool-tab labels traced to their minting code in this repo.
 * A prefix (`pbr03-`, `hcp-`, ...) is admissible under the same rule only
 * once its own minting code is found here — see `00_overview.md`'s Source
 * turn 5. No such minter has been traced for `pbr03-`/`hcp-` as of this
 * slice; they are deliberately absent from this set.
 */
const TRACED_THRONE_TOOL_TAB_LABELS: ReadonlySet<string> = new Set([]);

const STAGER_TAB_LABEL_PREFIX = 'stager-';

export interface StaleTabReport {
  readonly label: string;
  readonly tabId: string;
  readonly paneCount: number;
  readonly reason: string;
}

export function isStagerTabLabel(label: string): boolean {
  return label.startsWith(STAGER_TAB_LABEL_PREFIX);
}

export const TAB_AGENT_LIVENESS = {
  LIVE: 'live',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
} as const;

export type TabAgentLiveness =
  (typeof TAB_AGENT_LIVENESS)[keyof typeof TAB_AGENT_LIVENESS];

export function classifyTabAgentLiveness(
  tab: HerdrTab,
  panes: readonly HerdrPane[],
  liveAgents: readonly LiveAgentStatus[],
): TabAgentLiveness {
  const tabPanes = panes.filter((pane) => pane.tabId === tab.tabId);
  if (tabPanes.length === 0 || tabPanes.length !== tab.paneCount) {
    return TAB_AGENT_LIVENESS.UNKNOWN;
  }
  const livePaneIds = new Set(liveAgents.map((agent) => agent.paneId));
  return tabPanes.some((pane) => livePaneIds.has(pane.paneId))
    ? TAB_AGENT_LIVENESS.LIVE
    : TAB_AGENT_LIVENESS.ABSENT;
}

/**
 * Positive-identification-only judgment, in strict order of confidence, with
 * no denylist/"default name" fallback anywhere: an unrecognized label always
 * returns `undefined`, never a reason.
 */
function judgeThroneOwnedTabLabel(
  label: string,
  ledgerNames: ReadonlySet<string>,
): string | undefined {
  if (ledgerNames.has(label)) {
    return `label exactly matches a throne ledger agent name (${label})`;
  }
  if (TRACED_THRONE_TOOL_TAB_LABELS.has(label)) {
    return `label matches a traced throne tool tab (${label})`;
  }
  return undefined;
}

/**
 * Pure allowlist-only join: reports a tab ONLY when positively identified as
 * throne-owned (exact ledger-name match, or a traced tool-tab label), never
 * hosting a live agent, and not a `stager-*` tab. Everything else —
 * including a label that merely looks like a throne/default name — is left
 * silently alone. Never inspects or invokes tab-closing behavior.
 */
export function findStaleThroneTabs(
  tabs: readonly HerdrTab[],
  panes: readonly HerdrPane[],
  liveAgents: readonly LiveAgentStatus[],
  ledgerNames: ReadonlySet<string>,
): StaleTabReport[] {
  const report: StaleTabReport[] = [];
  for (const tab of tabs) {
    if (isStagerTabLabel(tab.label)) continue;
    if (
      classifyTabAgentLiveness(tab, panes, liveAgents) !==
      TAB_AGENT_LIVENESS.ABSENT
    ) continue;
    const reason = judgeThroneOwnedTabLabel(tab.label, ledgerNames);
    if (reason === undefined) continue;
    report.push({
      label: tab.label,
      tabId: tab.tabId,
      paneCount: tab.paneCount,
      reason,
    });
  }
  return report;
}

export interface StrandedSpawnReport {
  readonly agentName: string;
  readonly tabId: string;
  readonly classification: StrandedSpawnClassification;
}

/**
 * Only a tab whose label exactly matches a ledger AGENT name can be a
 * stranded spawn -- `opening-prompt.md` and the composer state are both
 * per-agent facts, so a traced tool tab is never a candidate. Reads the one
 * pane belonging to the tab; a tab herdr no longer
 * lists any pane for is left as a generic stale-tab candidate (nothing to
 * classify).
 */
async function classifyCandidateThroneTab(
  candidate: StaleTabReport,
  ledgerNames: ReadonlySet<string>,
  panes: readonly HerdrPane[],
  dataDir: string | undefined,
): Promise<StrandedSpawnReport | undefined> {
  if (!ledgerNames.has(candidate.label)) {
    return undefined;
  }
  const pane = panes.find((candidatePane) => candidatePane.tabId === candidate.tabId);
  if (pane === undefined) {
    return undefined;
  }
  const [paneAnsi, openingPromptExists, spawnSpec] = await Promise.all([
    readVisibleAnsi(pane.paneId),
    fileExists(openingPromptPath(candidate.label, dataDir)),
    readSpawnSpec(candidate.label, dataDir),
  ]);
  const classification = classifyStrandedSpawnPane(
    HARNESS_NAMES.CLAUDE,
    paneAnsi,
    openingPromptExists,
    {
      taskedAt: spawnSpec?.tasked_at,
      ageMs: spawnedAtAgeMs(spawnSpec?.spawned_at, Date.now()),
    },
  );
  return classification === undefined
    ? undefined
    : { agentName: candidate.label, tabId: candidate.tabId, classification };
}

/**
 * Splits `findStaleThroneTabs`'s allowlist candidates into the tabs that
 * are still genuinely stale (existing "no live agent, consider closing"
 * report, unchanged) and the ones that are actually a live, correctly-
 * provisioned spawn stuck behind a modal or a never/partially-submitted
 * opening prompt -- those must never reach the close-inviting report.
 */
async function splitStaleAndStrandedThroneTabs(
  candidates: readonly StaleTabReport[],
  ledgerNames: ReadonlySet<string>,
  panes: readonly HerdrPane[],
  dataDir: string | undefined,
): Promise<{
  staleTabs: StaleTabReport[];
  strandedSpawns: StrandedSpawnReport[];
}> {
  if (candidates.length === 0) {
    return { staleTabs: [], strandedSpawns: [] };
  }
  const staleTabs: StaleTabReport[] = [];
  const strandedSpawns: StrandedSpawnReport[] = [];
  for (const candidate of candidates) {
    const stranded = await classifyCandidateThroneTab(candidate, ledgerNames, panes, dataDir);
    if (stranded === undefined) {
      staleTabs.push(candidate);
    } else {
      strandedSpawns.push(stranded);
    }
  }
  return { staleTabs, strandedSpawns };
}

export async function collectThroneLedgerNames(
  ledgerData: Pick<
    LedgerDataService,
    'listRegisteredAgents' | 'listReapedAgentNames'
  >,
  dataDir?: string,
): Promise<Set<string>> {
  const [live, reaped] = await Promise.all([
    ledgerData.listRegisteredAgents(dataDir),
    ledgerData.listReapedAgentNames(dataDir),
  ]);
  return new Set([...live, ...reaped]);
}

async function classifiedThroneTabs(
  ledgerData: LedgerDataService,
  dataDir: string | undefined,
): Promise<{ staleTabs: StaleTabReport[]; strandedSpawns: StrandedSpawnReport[] }> {
  const [tabs, panes, liveAgents, ledgerNames] = await Promise.all([
    listTabs(),
    listPanes(),
    listLiveAgentStatuses(),
    collectThroneLedgerNames(ledgerData, dataDir),
  ]);
  const candidates = findStaleThroneTabs(tabs, panes, liveAgents, ledgerNames);
  return splitStaleAndStrandedThroneTabs(candidates, ledgerNames, panes, dataDir);
}

/**
 * Live end-to-end assembly: joins real `herdr tab list` output against the
 * real live agent roster and the throne ledger (live + reaped), then applies
 * `findStaleThroneTabs`'s allowlist judgment, minus whatever
 * `splitStaleAndStrandedThroneTabs` positively identifies as a stranded
 * spawn instead (see `detectStrandedSpawns`) -- a live, correctly-
 * provisioned spawn stuck behind a modal or an absent/unsubmitted opening
 * prompt never reaches this close-inviting report. Read-only throughout —
 * no code path here ever calls `herdr tab close` or any other tab-mutating
 * command; reporting to the Regent and deciding whether to close a tab are
 * both left to the caller.
 */
export async function detectStaleThroneTabs(
  ledgerData: LedgerDataService = new LedgerDataService(),
  dataDir?: string,
): Promise<StaleTabReport[]> {
  const { staleTabs } = await classifiedThroneTabs(ledgerData, dataDir);
  return staleTabs;
}

/**
 * The counterpart to `detectStaleThroneTabs`: every throne-ledger-matched
 * tab with no live agent whose pane content positively identifies it as a
 * stranded spawn rather than a dead tab. Read-only; never recovers or
 * closes anything itself.
 */
export async function detectStrandedSpawns(
  ledgerData: LedgerDataService = new LedgerDataService(),
  dataDir?: string,
): Promise<StrandedSpawnReport[]> {
  const { strandedSpawns } = await classifiedThroneTabs(ledgerData, dataDir);
  return strandedSpawns;
}
