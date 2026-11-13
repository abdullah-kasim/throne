import type { HerdrAgent } from '../herdr/herdr-inventory.service.ts';
import type { AgentStatusesRosterEntry } from '../agent-statuses/agent-statuses.types.ts';
import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import { isAlphaRole, isShadowRole, NO_IDLING_REGENT_NAME } from './idle-family.ts';
import { stuckDraftsToSubmit, type ComposerObservation } from './stuck-draft.ts';
import type { NoIdlingDependencies, StuckDraftMemory } from './no-idling-dependencies.types.ts';
import { writeErr, writeOut } from './no-idling-notify-guard.ts';

const LOGGED_DRAFT_LENGTH = 80;

export function emptyStuckDraftMemory(): StuckDraftMemory {
  return { sightings: new Map() };
}

interface Candidate {
  agent: HerdrAgent;
  observation: ComposerObservation;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readComposerOrUnavailable(
  deps: NoIdlingDependencies,
  agent: HerdrAgent,
): Promise<ActiveComposerSnapshot> {
  try {
    return await deps.readComposer(agent);
  } catch {
    return { state: 'unavailable' };
  }
}

async function readCandidates(
  deps: NoIdlingDependencies,
  roster: readonly AgentStatusesRosterEntry[],
  skippedAgentNames: ReadonlySet<string>,
): Promise<Candidate[]> {
  const names = roster
    .filter((entry) => entry.lifecycle === 'live' && (isAlphaRole(entry.role) || isShadowRole(entry.role)))
    .map((entry) => entry.name);
  const roleByName = new Map(roster.map((entry) => [entry.name, entry.role]));
  const candidates: Candidate[] = [];
  for (const name of new Set([...names, NO_IDLING_REGENT_NAME])) {
    if (skippedAgentNames.has(name)) continue;
    let agent: HerdrAgent;
    try {
      agent = await deps.resolveAgent(name);
    } catch {
      continue;
    }
    candidates.push({
      agent,
      observation: {
        paneId: agent.paneId,
        agentName: name,
        role: roleByName.get(name),
        isRegent: name === NO_IDLING_REGENT_NAME,
        composer: await readComposerOrUnavailable(deps, agent),
      },
    });
  }
  return candidates;
}

export async function sweepStuckDrafts(
  deps: NoIdlingDependencies,
  roster: readonly AgentStatusesRosterEntry[],
  skippedAgentNames: ReadonlySet<string>,
  notify: boolean,
): Promise<void> {
  const memory = deps.stuckDraftMemory ?? emptyStuckDraftMemory();
  const candidates = await readCandidates(deps, roster, skippedAgentNames);
  const decision = stuckDraftsToSubmit(
    memory.sightings,
    candidates.map((candidate) => candidate.observation),
    deps.now?.() ?? Date.now(),
  );
  memory.sightings = decision.nextSightings;
  for (const paneId of decision.toSubmit) {
    const candidate = candidates.find((each) => each.agent.paneId === paneId);
    if (candidate === undefined || candidate.observation.composer.state !== 'draft') continue;
    const shown = candidate.observation.composer.text.slice(0, LOGGED_DRAFT_LENGTH);
    if (!notify) {
      writeOut(deps, `no-idling: [dry-run] would press Enter on ${candidate.observation.agentName}'s stuck draft: ${shown}\n`);
      continue;
    }
    try {
      await deps.submitStuckDraft(candidate.agent);
      writeOut(deps, `no-idling: pressed Enter on ${candidate.observation.agentName}'s stuck draft: ${shown}\n`);
    } catch (error) {
      writeErr(deps, `no-idling: stuck draft of ${candidate.observation.agentName} did not submit: ${errorText(error)}\n`);
    }
  }
}
