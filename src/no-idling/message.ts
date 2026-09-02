import type { UntaskedAgent } from './find-untasked-agents.ts';
import type { StaleTabReport, StrandedSpawnReport } from './stale-tab-report.ts';
import {
  NO_IDLING_ALPHA_ROLE,
  isAlphaRole,
} from './idle-family.ts';
import type { ReapabilityProtocolViolation } from './reapability-protocol.ts';

export interface NoIdlingFamilyNotice {
  readonly alpha: string;
  readonly idleChildren: readonly string[];
  // Undefined is treated as `NO_IDLING_ALPHA_ROLE` -- every pre-existing
  // caller omits this field and every one of them is reporting a genuine
  // Alpha, so this preserves their exact prior message text unchanged. Only
  // the real sweep caller (`no-idling-run.ts`) ever sets this to a
  // non-Alpha value, resolved from the same roster the family names came
  // from.
  readonly role?: string;
  // Present only for an orphan: a `findBareEntryPoints` entry whose recorded
  // supervisor is someone other than the Regent but is not a live Alpha --
  // its supervising Alpha existed and is now gone. Threaded straight through
  // from `FullyIdleFamily.orphanedSupervisorName`; see that field's doc
  // comment for what distinguishes an orphan from a by-design direct report.
  readonly orphanedSupervisorName?: string;
}

export interface NoIdlingMessageParams {
  readonly families: readonly NoIdlingFamilyNotice[];
  readonly reapabilityProtocolViolations?: readonly ReapabilityProtocolViolation[];
}

function describeFamilyChildren(idleChildren: readonly string[]): string {
  return idleChildren.length === 0 ? 'no idle children' : `idle children: ${idleChildren.join(', ')}`;
}

function isAlphaRoleNotice(family: NoIdlingFamilyNotice): boolean {
  return isAlphaRole(family.role ?? NO_IDLING_ALPHA_ROLE);
}

/**
 * A non-Alpha entry (an orphaned Shadow, a custom `agent-`-prefixed agent --
 * see `findBareEntryPoints`'s doc comment) never consumes slices, repairs,
 * reaps, or dispatches children, and must never be offered the
 * `{"blocked":true}` self-publish marker, which presumes Alpha-shaped
 * responsibilities a Shadow does not have. FP4's own report: `shadow-fpo-01`
 * was told to do exactly that.
 */
function buildNonAlphaRoleFamiliesSection(nonAlphaFamilies: readonly NoIdlingFamilyNotice[]): string {
  const details = nonAlphaFamilies
    .map(
      ({ alpha, idleChildren, role }) =>
        `${alpha} (${role ?? 'unknown role'}, ${describeFamilyChildren(idleChildren)})`,
    )
    .join('; ');
  return `No-idling detected fully-idle non-Alpha agent(s) that need Regent attention: ${details}. These do not consume slices, repair, reap, or dispatch children, and must never be told to publish the standalone JSON {"blocked":true} -- that self-suppression marker is Alpha-shaped. Inspect each directly with send-agent using guidance appropriate to its own role.`;
}

/**
 * An orphan's supervising Alpha existed and is now gone -- it never merely
 * looks idle, it has genuinely lost the agent it reports DONE to. The
 * remediation is neither the Alpha-shaped notice (wrong role) nor the
 * generic non-Alpha notice (correct role, but silent on the one fact that
 * actually matters here): the Regent must ADOPT it -- become its effective
 * contact -- not "inspect with guidance appropriate to its role". Real
 * incident: shadow-hdl-99e-deliver-hdl outlived alpha-hdl-delivery-precondition
 * going COMPLETE, could not send-agent its DONE report to a supervisor that
 * no longer existed, and correctly refused to self-merge or self-reap.
 */
function buildOrphanFamiliesSection(orphanFamilies: readonly NoIdlingFamilyNotice[]): string {
  const details = orphanFamilies
    .map(
      ({ alpha, idleChildren, role, orphanedSupervisorName }) =>
        `${alpha} (${role ?? 'unknown role'}, orphaned -- its supervisor ${orphanedSupervisorName} is gone, ${describeFamilyChildren(idleChildren)})`,
    )
    .join('; ');
  return `No-idling detected ORPHANED agent(s) whose supervisor no longer exists: ${details}. Each has a genuine supervisor gap, not mere idleness -- it cannot send-agent a DONE report to an agent that is gone, and must not self-merge or self-reap. The Regent must ADOPT each one directly: take over as its effective contact, read its state, and give it its next instruction or a disposition. Never treat these as idle Alphas needing unstalling and never offer the {"blocked":true} marker.`;
}

function buildAlphaRoleFamiliesSection(alphaFamilies: readonly NoIdlingFamilyNotice[]): string {
  const details = alphaFamilies
    .map(({ alpha, idleChildren }) => `${alpha} (${describeFamilyChildren(idleChildren)})`)
    .join('; ');
  return `No-idling detected fully-idle Alpha(s) that need Regent unstalling: ${details}. Inspect each named Alpha and its children. If an Alpha is genuinely dependency-blocked, tell it to publish the standalone JSON {"blocked":true} as its latest message so future no-idling sweeps ignore it. Otherwise use send-agent with an actionable consume, repair, reap, and dependency-ready dispatch instruction. Do not send a generic continue message and do not start a validation round solely because of this notice.`;
}

export function buildNoIdlingMessage(params: NoIdlingMessageParams): string {
  const alphaFamilies = params.families.filter(isAlphaRoleNotice);
  const nonAlphaFamilies = params.families.filter((family) => !isAlphaRoleNotice(family));
  const orphanFamilies = nonAlphaFamilies.filter(
    (family) => family.orphanedSupervisorName !== undefined,
  );
  const otherNonAlphaFamilies = nonAlphaFamilies.filter(
    (family) => family.orphanedSupervisorName === undefined,
  );
  const sections: string[] = [];
  if (alphaFamilies.length > 0) {
    sections.push(buildAlphaRoleFamiliesSection(alphaFamilies));
  }
  if (orphanFamilies.length > 0) {
    sections.push(buildOrphanFamiliesSection(orphanFamilies));
  }
  if (otherNonAlphaFamilies.length > 0) {
    sections.push(buildNonAlphaRoleFamiliesSection(otherNonAlphaFamilies));
  }
  if ((params.reapabilityProtocolViolations?.length ?? 0) > 0) {
    const details = params.reapabilityProtocolViolations!
      .map(({ agent, reason }) => `${agent} (${reason})`)
      .join('; ');
    sections.push(
      `Reapability protocol violation(s): ${details}. These are level-triggered observations and will be paged again on every unchanged sweep. The retired marker is diagnostic evidence only and never authorizes reap-agent; ask each named agent whether it is reapable or merely idle and require a supported standalone JSON claim before teardown.`,
    );
  }
  return sections.join(' ');
}

export interface DependencyClearedMessageParams {
  readonly resolvedChildren: readonly string[];
}

/**
 * The direct wake message for an agent whose every named `blockedBy` child
 * no longer has a live ledger registration. Names the exact children so the
 * message can never be sent unchanged to two different blocked agents.
 */
export function buildDependencyClearedMessage(params: DependencyClearedMessageParams): string {
  const children = params.resolvedChildren.join(', ');
  const plural = params.resolvedChildren.length > 1;
  return (
    `The child${plural ? 'ren' : ''} you were blocked on -- ${children} -- ` +
    `no longer ${plural ? 'have' : 'has'} a live ledger registration; ` +
    `reaped, swept, or otherwise torn down. Your block is cleared. Resume ` +
    `and act on that.`
  );
}

export interface UntaskedAgentsMessageParams {
  readonly untasked: readonly UntaskedAgent[];
}

export function buildUntaskedAgentsMessage(params: UntaskedAgentsMessageParams): string {
  const details = params.untasked
    .map(
      ({ name, role, ageMs }) => `${name} (${role}) — idle and untasked for ~${Math.floor(ageMs / 60_000)}m`,
    )
    .join('; ');
  return `No-idling detected live agent(s) that were spawned but never tasked: ${details}. Their create-agent call landed but the follow-up send-agent assignment never did. Use send-agent to give each named agent its assignment now.`;
}

export interface StaleTabsMessageParams {
  readonly staleTabs: readonly StaleTabReport[];
}

export function buildStaleTabsMessage(params: StaleTabsMessageParams): string {
  const details = params.staleTabs
    .map(
      ({ label, tabId, paneCount, reason }) =>
        `${label} (tab ${tabId}, ${paneCount} pane(s)) — ${reason}`,
    )
    .join('; ');
  return `No-idling detected throne-owned tab candidate(s) with resolved panes and no live agent: ${details}. Inspect each and close it with herdr tab close if it is genuinely stale; this notice never closes a tab itself.`;
}

export interface StrandedSpawnsMessageParams {
  readonly strandedSpawns: readonly StrandedSpawnReport[];
}

const STRANDED_SPAWN_CLASSIFICATION_DESCRIPTION: Readonly<
  Record<StrandedSpawnReport['classification'], string>
> = {
  MODAL_BLOCKING: 'blocked behind a startup modal that ate its pane focus',
  STRANDED_SPAWN: 'its opening prompt was never delivered',
  PROMPT_UNSUBMITTED: 'its opening prompt is sitting unsubmitted in the composer',
};

/**
 * A live, correctly-provisioned agent stuck behind a modal or a
 * never/partially-submitted opening prompt is not a dead tab -- closing it
 * would destroy real campaign state. This notice never suggests closing;
 * see `buildStaleTabsMessage` for the genuinely-dead-tab counterpart.
 */
export function buildStrandedSpawnsMessage(params: StrandedSpawnsMessageParams): string {
  const details = params.strandedSpawns
    .map(
      ({ agentName, tabId, classification }) =>
        `${agentName} (tab ${tabId}, ${classification}) — ${STRANDED_SPAWN_CLASSIFICATION_DESCRIPTION[classification]}`,
    )
    .join('; ');
  return `No-idling detected live agent(s) stranded during spawn, never a dead tab: ${details}. Each is correctly provisioned and mid-campaign; never close its tab. Recover it directly: answer the modal for MODAL_BLOCKING, redeliver opening-prompt.md for STRANDED_SPAWN, or press Enter in the composer for PROMPT_UNSUBMITTED — never redeliver the prompt to a PROMPT_UNSUBMITTED agent, that would double it.`;
}
