import {
  buildPointerMessage,
  requiresFileBackedDelivery,
} from "../send-agent/payload-transport.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import type { SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import type { KeyedSubmissionWindowStore } from "./keyed-submission-token.ts";
import { submitToAgentWhileLocked } from "./herdr-send-transaction.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import { sameRecipientPaneIdentity } from "./herdr-identity.service.ts";
import {
  enterUntilEmptyTransactionFor,
  recipientIdentityText,
  recipientName,
  resolveComposerWaitDeadline,
  submittedPayload,
} from "./herdr-send.helpers.ts";
import {
  observeSupportedScreen,
  supportedComposerHarness,
  waitForEmptyComposer,
  waitForRecognizedComposer,
} from "./herdr-screen.service.ts";
import { pressEnterUntilEmptyTextbox } from "./herdr-send-enter-until-empty.ts";
import {
  RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS,
  SubmitAssumedFilledError,
  SubmitNotSentError,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from "./herdr-send.types.ts";

/**
 * Runs under the recipient lock, briefly, purely to settle exclusive
 * ownership before pressing Enter on someone else's resident text — never to
 * hold the lock for this delivery's own payload (that lock is acquired
 * separately, afterward). Re-observes the composer under the lock rather
 * than trusting the pre-lock observation that triggered this call: the pane
 * may have changed in the gap between the deadline firing and the lock
 * being granted. Only a re-confirmed `draft` is force-submitted; anything
 * else (cleared on its own, or now `modal`/`unavailable`) is left
 * completely untouched.
 *
 * This is the SECOND, independent guard against ever pressing Enter on a
 * `modal` composer — the caller (`waitForEmptyComposerForcingResidentDraft`)
 * already refuses to call this function at all unless its own re-observation
 * found `draft`, so a modal pane never reaches here in practice. This
 * function keeps its own `!== "draft"` check anyway rather than trusting the
 * caller, so the property (never Enter on modal) holds even if a future
 * caller is added that skips that first guard.
 */
async function forceSubmitResidentDraftUnderLock(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deps: SubmitToAgentDeps,
): Promise<void> {
  await deps.withRecipientPaneLock(agent.paneId, async () => {
    const reobserved = await observeSupportedScreen(agent, harness, deps);
    if (reobserved.activeComposer.state !== "draft") return;
    const { clearance, bounds } = enterUntilEmptyTransactionFor(harness);
    await pressEnterUntilEmptyTextbox(
      agent,
      reobserved.activeComposer.text,
      clearance,
      deps,
      bounds,
    );
  });
}

/**
 * Waits for the composer to clear on its own within `deadline`; on a
 * `draft`-specific timeout, force-submits it (Enter-first — the human's own
 * text is sent, not destroyed) instead of reporting not-sent, UNLESS the
 * caller opted out (`forceSubmitResidentDraftOnTimeout === false`, the
 * `send-agent-legacy` rescue path). THE FIRST GUARD against ever pressing
 * Enter on a `modal` composer: forcing is only even attempted when
 * re-observing after the deadline finds `state === "draft"` specifically —
 * `modal` and `unavailable` timeouts always rethrow `waitError` untouched,
 * regardless of `forceOnTimeout`.
 */
async function waitForEmptyComposerForcingResidentDraft(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  deadline: number,
  deps: SubmitToAgentDeps,
  forceOnTimeout: boolean,
): Promise<void> {
  try {
    await waitForEmptyComposer(agent, harness, deadline, deps);
    return;
  } catch (waitError) {
    if (!forceOnTimeout) throw waitError;
    const stillObserved = await observeSupportedScreen(agent, harness, deps).catch(
      () => undefined,
    );
    if (stillObserved?.activeComposer.state !== "draft") throw waitError;
    await forceSubmitResidentDraftUnderLock(agent, harness, deps);
  }
}

/**
 * The tuple's live payload right now — read by a keyed window's owner at
 * both reread checkpoints (right after acquiring the recipient lock, and
 * again immediately before submission).
 */
async function rereadKeyedPayload(
  name: string,
  key: string,
  store: KeyedSubmissionWindowStore,
): Promise<{ senderName: string; prompt: string; options: SubmitToAgentOptions }> {
  const snapshot = await store.reread(name, key);
  if (snapshot === undefined) {
    throw new Error(`keyed submission window for "${name}" vanished before delivery`);
  }
  return {
    senderName: snapshot.payload.senderName,
    prompt: snapshot.payload.prompt,
    options: snapshot.payload.options as SubmitToAgentOptions,
  };
}

/**
 * Whether the pre-lock composer wait applies at all for this call — shared
 * between the actual wait below and `probeComposerCleared`'s single-shot
 * check, so the two can never silently diverge on when a draft outranks the
 * sender.
 */
function composerWaitApplies(
  harness: SupportedComposerHarness | undefined,
  options: SubmitToAgentOptions,
): harness is SupportedComposerHarness {
  return (
    harness !== undefined &&
    options.skipText !== true &&
    // omp owns its own draft wait, inside the extension, by reading the REAL
    // composer buffer. This screen-based wait cannot serve it: omp panes are
    // `screen_detection_skipped`, so the observation never resolves and the
    // wait runs to its full ceiling before the submit is even attempted —
    // measured as a hang, not a refusal. Skipping it here is not weaker
    // protection, it is the same protection moved somewhere that can actually
    // see the draft.
    harness !== HARNESS_NAMES.OMP &&
    !(harness === HARNESS_NAMES.CODEX && options.waitForStartupQuiescence)
  );
}

/**
 * One observation of whether the pre-lock composer wait would clear
 * immediately, without entering the wait's own poll-and-sleep loop. Returns
 * `true` whenever the actual wait below would not block at all — either
 * because it does not apply (unsupported harness, `skipText`, Codex startup
 * quiescence) or because a live probe finds the composer already `empty`.
 * Any observation failure (unrecognized composer, transient read error) is
 * reported as "not yet cleared", matching this call's job: decide whether to
 * yield, never to fail the delivery — a genuine failure still surfaces from
 * the real wait/write phases that run after this returns `true`.
 */
export async function probeComposerCleared(
  agent: HerdrAgent,
  options: SubmitToAgentOptions,
  deps: SubmitToAgentDeps,
): Promise<boolean> {
  if (options.forceImmediate === true) return true;
  const harness = supportedComposerHarness(agent.agent);
  if (!composerWaitApplies(harness, options)) return true;
  try {
    const snapshot = await waitForRecognizedComposer(agent, harness, deps.now(), deps);
    return snapshot.activeComposer.state === "empty";
  } catch {
    return false;
  }
}

/**
 * The unkeyed delivery transaction: draft-wait, recipient lock, optional
 * file-backed staging, then the bounded submit transaction. A keyed delivery
 * window's owner reuses this directly (`keyedWindow` set) so the two paths
 * never duplicate the lock/staging/submit sequence.
 */
export async function submitToAgentUnkeyed(
  agent: HerdrAgent,
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions,
  deps: SubmitToAgentDeps,
  keyedWindow?: { name: string; key: string; store: KeyedSubmissionWindowStore },
): Promise<void> {
  const name = recipientName(agent);
  if (options.forceImmediate === true) {
    await deps.sendText(
      agent.paneId,
      submittedPayload(senderName, prompt, options),
    );
    await deps.pressEnter(agent.paneId);
    return;
  }
  const harness = supportedComposerHarness(agent.agent);
  try {
    // A resident draft outranks every sender: wait for it to clear BEFORE
    // competing for the recipient lock, bounded by the existing composer
    // deadline. Timing out here is typed not-sent — nothing was written and
    // nothing was overwritten. Enter-only delivery needs the draft, and the
    // Codex startup path settles under the lock, so both skip this wait.
    if (composerWaitApplies(harness, options)) {
      const requestedWaitMilliseconds =
        options.composerWaitMilliseconds ?? RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS;
      const clearanceDeadline = await resolveComposerWaitDeadline(
        agent,
        harness,
        requestedWaitMilliseconds,
        deps,
      );
      await waitForEmptyComposerForcingResidentDraft(
        agent,
        harness,
        clearanceDeadline,
        deps,
        // An explicit zero-length wait is the court's established "skip the
        // wait, fail fast" idiom (send-agent-legacy and pre-existing test
        // fixtures both pass `composerWaitMilliseconds: 0` to mean exactly
        // that). No wait happened here to justify forcing anything, so a
        // zero deadline never forces regardless of the flag below.
        requestedWaitMilliseconds > 0 &&
          (options.forceSubmitResidentDraftOnTimeout ?? true),
      );
    }
    await deps.withRecipientPaneLock(agent.paneId, async () => {
      // The owner rereads the tuple's latest payload immediately after
      // acquiring the recipient lock, and again immediately before the
      // actual submit call: either reread may surface a newer payload than
      // the one the owner started with (last-write-wins at both checkpoints).
      let live = keyedWindow
        ? await rereadKeyedPayload(keyedWindow.name, keyedWindow.key, keyedWindow.store)
        : { senderName, prompt, options };
      const refreshed = await deps.refreshRecipientIdentity(name, agent);
      if (!sameRecipientPaneIdentity(agent, refreshed)) {
        throw new Error(
          "recipient identity changed while waiting for pane lock: expected " +
            `${recipientIdentityText(agent)}; observed ${recipientIdentityText(refreshed)}`,
        );
      }
      if (keyedWindow) {
        live = await rereadKeyedPayload(keyedWindow.name, keyedWindow.key, keyedWindow.store);
      }
      let effectivePrompt = live.prompt;
      if (
        live.options.skipText !== true &&
        live.options.disableFileBackedDelivery !== true &&
        deps.fileBackedPayloadsEnabled === true &&
        (live.options.forceFileBackedDelivery === true ||
          requiresFileBackedDelivery(
            submittedPayload(live.senderName, live.prompt, live.options),
          ))
      ) {
        effectivePrompt = buildPointerMessage(
          await deps.stagePayload(name, live.prompt),
        );
      }
      await submitToAgentWhileLocked(
        refreshed,
        live.senderName,
        effectivePrompt,
        live.options,
        deps,
      );
      await live.options.onDeliveredWhileLocked?.();
    });
  } catch (error) {
    if (
      error instanceof SubmitNotSentError ||
      error instanceof SubmitAssumedFilledError
    ) {
      throw error;
    }
    throw new SubmitNotSentError(name, error);
  }
}
