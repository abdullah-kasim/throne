import { inspectSupportedAgentScreen } from '../codex-screen/composer/composer.service.ts';
import type { SupportedComposerHarness } from '../codex-screen/composer/composer.types.ts';
import { AGENT_MIN_AGE_MS } from './idle-family.ts';

/**
 * A throne-ledger-matched tab herdr reports as hosting no live agent can
 * still be a live, correctly-provisioned spawn that simply never reached
 * its composer -- three confirmed shapes, all indistinguishable from a dead
 * tab by turn count alone (see `00_overview.md`'s Source turns 1 and 6).
 * `undefined` means none of the three shapes matched; the caller falls
 * through to the existing dead-tab report.
 */
export type StrandedSpawnClassification =
  | 'MODAL_BLOCKING'
  | 'STRANDED_SPAWN'
  | 'PROMPT_UNSUBMITTED';

/**
 * Durable delivery evidence for the opening prompt, read from `spawn.json`
 * the same way `find-untasked-agents` already does: `taskedAt` is `null`
 * when the agent is registered but `send-agent`/`create-agent` has never
 * recorded a delivery, an ISO string once one has (durable proof of
 * delivery regardless of the composer's current, momentary state), and
 * `undefined` for a record that predates the field -- "unknown," never
 * "never delivered." `ageMs` is the same `spawnedAtAgeMs` age-since-spawn
 * figure `find-untasked-agents` gates on, `undefined` when it cannot be
 * computed.
 */
export interface StrandedSpawnDurableEvidence {
  readonly taskedAt: string | null | undefined;
  readonly ageMs: number | undefined;
}

/**
 * Classifies a throne-ledger-matched pane against the three confirmed
 * stranding shapes, reusing `inspectSupportedAgentScreen`'s already-proven
 * composer-state detection rather than re-deriving modal/draft text
 * matching: a numbered-choice menu (either confirmed first-run modal reads
 * as one) is `activeComposer.state === 'modal'`; the opening prompt sitting
 * unsubmitted in the composer is `'draft'` with non-empty text.
 *
 * An empty composer plus `opening-prompt.md` still on disk is NOT, by
 * itself, evidence the prompt was never delivered -- an actively generating
 * agent produces the same empty-composer, file-still-present shape while
 * mid-turn, and the file persists on disk regardless of delivery. Reaching
 * `STRANDED_SPAWN` additionally requires `durableEvidence.taskedAt === null`
 * (the ledger has never recorded a delivery to this agent) and the agent
 * having cleared the same `AGENT_MIN_AGE_MS` boot-quiescence floor
 * `find-untasked-agents` uses, so a spawn barely a minute old -- too young
 * for its own `create-agent` tasking call to have landed yet -- is never
 * misclassified either.
 */
export function classifyStrandedSpawnPane(
  harness: SupportedComposerHarness,
  paneAnsi: string,
  openingPromptExists: boolean,
  durableEvidence: StrandedSpawnDurableEvidence,
): StrandedSpawnClassification | undefined {
  const { activeComposer } = inspectSupportedAgentScreen(harness, paneAnsi);
  if (activeComposer.state === 'modal') {
    return 'MODAL_BLOCKING';
  }
  if (activeComposer.state === 'draft' && activeComposer.text.length > 0) {
    return 'PROMPT_UNSUBMITTED';
  }
  if (
    activeComposer.state === 'empty' &&
    openingPromptExists &&
    durableEvidence.taskedAt === null &&
    durableEvidence.ageMs !== undefined &&
    durableEvidence.ageMs >= AGENT_MIN_AGE_MS
  ) {
    return 'STRANDED_SPAWN';
  }
  return undefined;
}
