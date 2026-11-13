import type { ActiveComposerSnapshot } from '../codex-screen/composer/composer.types.ts';
import { isAlphaRole, isShadowRole } from './idle-family.ts';

export const STUCK_DRAFT_AGE_MS = 60_000;

export interface DraftSighting {
  text: string;
  firstSeenAt: number;
}

export interface ComposerObservation {
  paneId: string;
  agentName: string;
  role: string | undefined;
  isRegent: boolean;
  composer: ActiveComposerSnapshot;
}

export interface StuckDraftDecision {
  toSubmit: string[];
  nextSightings: Map<string, DraftSighting>;
}

function watchedRole(observation: ComposerObservation): boolean {
  return observation.isRegent || isAlphaRole(observation.role) || isShadowRole(observation.role);
}

export function stuckDraftsToSubmit(
  sightings: ReadonlyMap<string, DraftSighting>,
  observations: readonly ComposerObservation[],
  nowMs: number,
): StuckDraftDecision {
  const toSubmit: string[] = [];
  const nextSightings = new Map<string, DraftSighting>();
  for (const observation of observations) {
    const { composer, paneId } = observation;
    if (!watchedRole(observation) || composer.state !== 'draft' || composer.text.trim() === '') {
      continue;
    }
    const previous = sightings.get(paneId);
    if (previous === undefined || previous.text !== composer.text) {
      nextSightings.set(paneId, { text: composer.text, firstSeenAt: nowMs });
      continue;
    }
    if (nowMs - previous.firstSeenAt >= STUCK_DRAFT_AGE_MS) toSubmit.push(paneId);
    nextSightings.set(paneId, previous);
  }
  return { toSubmit, nextSightings };
}
