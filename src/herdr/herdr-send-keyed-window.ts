import { REAL_KEYED_SUBMISSION_WINDOW_STORE } from './keyed-submission-token.ts';
import type {
  KeyedSubmissionOutcome,
  KeyedSubmissionWindowStore,
} from './keyed-submission-token.ts';
import { submitToAgentUnkeyed } from './herdr-send-unkeyed.ts';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import { recipientName } from './herdr-send.helpers.ts';
import {
  RESIDENT_COMPOSER_POLL_MS,
  RESIDENT_COMPOSER_TIMEOUT_MS,
  SubmitAssumedFilledError,
  SubmitNotSentError,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from './herdr-send.types.ts';

/**
 * Only `SubmitNotSentError` proves nothing was written (the `empty` state);
 * every other error — including one this transport does not recognize —
 * defaults to `filled`, never `not-sent`, so a joined caller is never told
 * an unproven outcome is safe to retry.
 */
export function classifySubmitError(error: unknown): KeyedSubmissionOutcome & { status: 'rejected' } {
  const message = error instanceof Error ? error.message : String(error);
  const kind = error instanceof SubmitNotSentError ? 'not-sent' : 'filled';
  return { status: 'rejected', message, kind };
}

/** Raises (or resolves) the shared outcome exactly the way the owner's own attempt would have. */
function applyKeyedOutcome(name: string, outcome: KeyedSubmissionOutcome): void {
  if (outcome.status === 'fulfilled') return;
  if (outcome.kind === 'filled') {
    throw new SubmitAssumedFilledError(name, outcome.message);
  }
  throw new SubmitNotSentError(name, new Error(outcome.message));
}

/** Runs the one live delivery attempt for a window and publishes its outcome to every joined waiter. */
async function runOwnedKeyedWindow(
  agent: HerdrAgent,
  name: string,
  key: string,
  store: KeyedSubmissionWindowStore,
  deps: SubmitToAgentDeps,
): Promise<void> {
  try {
    await submitToAgentUnkeyed(agent, '', '', {}, deps, { name, key, store });
  } catch (error) {
    await store.publishOutcome(name, key, classifySubmitError(error));
    throw error;
  }
  await store.publishOutcome(name, key, { status: 'fulfilled' });
}

/**
 * A caller whose claim did not win ownership: it never competes for the
 * recipient lock itself. It polls the shared window for the owner's outcome,
 * and — if the owner's process is no longer live — takes over as the new
 * owner and delivers the latest payload itself. The poll bound reuses the
 * existing resident-composer wait policy rather than inventing a new one.
 */
async function joinKeyedWindow(
  agent: HerdrAgent,
  name: string,
  key: string,
  store: KeyedSubmissionWindowStore,
  deps: SubmitToAgentDeps,
): Promise<void> {
  const deadline = deps.now() + RESIDENT_COMPOSER_TIMEOUT_MS;
  while (true) {
    const snapshot = await store.reread(name, key);
    if (snapshot?.outcome !== undefined) {
      applyKeyedOutcome(name, snapshot.outcome);
      return;
    }
    if (await store.attemptIsAbandoned(name, key)) {
      if (await store.takeOverAttempt(name, key)) {
        await runOwnedKeyedWindow(agent, name, key, store, deps);
        return;
      }
      continue;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new SubmitAssumedFilledError(
        name,
        'a joined keyed delivery window exceeded the bounded wait for a shared outcome',
      );
    }
    await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
  }
}

export async function submitToAgentKeyed(
  agent: HerdrAgent,
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions,
  deps: SubmitToAgentDeps,
): Promise<void> {
  const name = recipientName(agent);
  const key = options.key!;
  const store = deps.keyedSubmissionWindowStore ?? REAL_KEYED_SUBMISSION_WINDOW_STORE;
  const { key: _omitted, ...payloadOptions } = options;
  const claim = await store.claim(
    name,
    key,
    { senderName, prompt, options: payloadOptions },
    deps.now(),
  );
  if (claim.owner) {
    await runOwnedKeyedWindow(agent, name, key, store, deps);
    return;
  }
  await joinKeyedWindow(agent, name, key, store, deps);
}
