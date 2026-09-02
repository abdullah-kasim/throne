import { isSupportedComposerEmpty } from "../codex-screen/composer/composer.service.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { OMP_DELIVERY_TIMEOUT_MS } from "./herdr-send.types.ts";
import {
  dismissOpenCodeMessageActionsModal,
  waitForSettledOpenCodeComposer,
  waitForStableOpenCodeResidentRepresentation,
} from "./herdr-opencode.service.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import {
  enterUntilEmptyTransactionFor,
  recipientName,
  resolveComposerWaitDeadline,
  submittedPayload,
} from "./herdr-send.helpers.ts";
import {
  observeCodexScreenWithRecentPrompts,
  observeCodexStartupFrame,
  observeSupportedScreen,
  supportedComposerHarness,
  waitForRecognizedComposer,
  waitForSettledCodexComposer,
} from "./herdr-screen.service.ts";
import {
  waitForSettledClaudeComposer,
  waitForStableClaudeResidentRepresentation,
} from "./herdr-claude.service.ts";
import { waitForCodexDraftRepresentation } from "./herdr-codex.service.ts";
import { pressEnterUntilEmptyTextbox, REAL_SUBMIT_TO_AGENT_DEPS } from "./herdr-send-enter-until-empty.ts";
import {
  COMPOSER_RECOGNITION_TIMEOUT_MS,
  COMPOSER_VISIBILITY_TIMEOUT_MS,
  RESIDENT_COMPOSER_POLL_MS,
  RESIDENT_COMPOSER_TIMEOUT_MS,
  SubmitAssumedFilledError,
  SubmitNotSentError,
  type SubmitToAgentDeps,
  type SubmitToAgentOptions,
} from "./herdr-send.types.ts";

/**
 * Step 3 of the submit handshake: wait for the just-written payload to
 * become visible in the composer before this court ever presses Enter (or,
 * for text-only callers, before treating delivery as complete). Reuses each
 * harness's existing resident-representation waiter rather than adding a new
 * observer — Claude's and OpenCode's already bound themselves internally to
 * `COMPOSER_VISIBILITY_TIMEOUT_MS`; Codex's takes an explicit deadline, given
 * the same bound so all three share one confirm-written ceiling.
 */
async function confirmPayloadWritten(
  agent: HerdrAgent,
  harness: NonNullable<ReturnType<typeof supportedComposerHarness>>,
  name: string,
  deps: SubmitToAgentDeps,
): Promise<void> {
  if (harness === HARNESS_NAMES.CODEX) {
    await waitForCodexDraftRepresentation(
      agent,
      name,
      deps.now() + COMPOSER_VISIBILITY_TIMEOUT_MS,
      deps,
    );
    return;
  }
  const waitForStableResidentRepresentation =
    harness === HARNESS_NAMES.OPENCODE
      ? waitForStableOpenCodeResidentRepresentation
      : waitForStableClaudeResidentRepresentation;
  const residentRepresentation = await waitForStableResidentRepresentation(
    agent,
    deps,
  );
  if (residentRepresentation === undefined) {
    throw new SubmitAssumedFilledError(
      name,
      "payload transport began but no stable resident representation appeared",
    );
  }
}

async function submitEnterOnlyWhileLocked(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<void> {
  const name = recipientName(agent);
  const harness = supportedComposerHarness(agent.agent);
  if (harness === undefined) {
    throw new SubmitAssumedFilledError(
      name,
      "enter-only delivery requires a recognized composer harness",
    );
  }
  const baseline = await waitForRecognizedComposer(
    agent,
    harness,
    deps.now() + COMPOSER_RECOGNITION_TIMEOUT_MS,
    deps,
  );
  if (baseline.activeComposer.state === "modal") {
    throw new SubmitAssumedFilledError(
      name,
      "the active composer is covered by an interactive dialog; " +
        "Enter would activate it",
    );
  }
  if (baseline.activeComposer.state !== "draft") {
    throw new SubmitAssumedFilledError(
      name,
      "enter-only delivery requires a resident draft to settle",
    );
  }
  const expected = baseline.activeComposer.text;
  const guarded = await observeSupportedScreen(agent, harness, deps);
  if (
    guarded.activeComposer.state !== "draft" ||
    guarded.activeComposer.text !== expected
  ) {
    throw new SubmitAssumedFilledError(
      name,
      "resident draft changed before enter-only could press Enter",
    );
  }
  const { clearance, bounds } = enterUntilEmptyTransactionFor(harness);
  await pressEnterUntilEmptyTextbox(agent, expected, clearance, deps, bounds);
}

/**
 * The send transaction's give-up point: a composer is `empty` or `filled`,
 * never a third "indeterminate" state that just relabels our own inability
 * to observe it. Once the bounded transaction runs out of looks, it assumes
 * `filled` (never resend into a possibly-already-submitted composer) — the
 * structurally initialized positive default, not an else-branch guess.
 */
function asAssumedFilled(
  name: string,
  error: unknown,
): SubmitAssumedFilledError {
  return error instanceof SubmitAssumedFilledError
    ? error
    : new SubmitAssumedFilledError(
        name,
        `post-send interaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
}

/**
 * The per-harness submit transaction, run under the held recipient lock:
 * flushes any text already resident in the composer, writes the payload,
 * then presses Enter through the bounded clearance transaction.
 */
export async function submitToAgentWhileLocked(
  agent: HerdrAgent,
  senderName: string,
  prompt: string,
  options: SubmitToAgentOptions = {},
  deps: SubmitToAgentDeps = REAL_SUBMIT_TO_AGENT_DEPS,
): Promise<void> {
  const name = recipientName(agent);
  const harness = supportedComposerHarness(agent.agent);
  await dismissOpenCodeMessageActionsModal(agent, deps);
  if (options.skipText) {
    try {
      await submitEnterOnlyWhileLocked(agent, deps);
    } catch (error) {
      throw asAssumedFilled(name, error);
    }
    return;
  }
  // omp does not go through the composer at all. Its panes are
  // `screen_detection_skipped`, so the observation behind "never overwrite a
  // resident draft" has nothing to read and the Claude-branch submit contract
  // does not apply — measured 2026-08-26, the keystroke path wrote the payload
  // and never submitted it. Delivery instead hands the payload to the throne's
  // omp extension, which reads the ACTUAL composer buffer and enqueues a real
  // user turn. Still under the recipient lock, still behind the durable queue:
  // only this innermost submit changes.
  if (harness === HARNESS_NAMES.OMP) {
    const outcome = await deps.deliverToOmp(
      submittedPayload(senderName, prompt, options),
      options.composerWaitMilliseconds ?? OMP_DELIVERY_TIMEOUT_MS,
      // ADDRESSED to this recipient's pane. Every live omp instance polls the
      // same directory, so an unaddressed request is claimed by whichever one
      // is idle first — see the defect note in omp-delivery-client.ts.
      agent.paneId,
    );
    if (outcome.kind === "delivered") return;
    if (outcome.kind === "refused") {
      throw new SubmitNotSentError(
        name,
        new Error(`omp delivery refused: ${outcome.detail}`),
      );
    }
    // Timed out with the request already withdrawn: nothing was submitted and
    // nothing was overwritten, which is precisely typed not-sent.
    throw new SubmitNotSentError(
      name,
      new Error(
        `omp delivery timed out after ${outcome.waitedMs}ms with no ack — the ` +
          `extension holds a request while a resident draft is present, and ` +
          `holds it equally while the composer is unreadable. The request was ` +
          `withdrawn, so nothing will arrive late.`,
      ),
    );
  }
  // Keep delivery on the proven send-text + bounded Enter transaction: the
  // herdr agent-prompt primitive can mis-handle queued/draft composer state.
  const literalPayload = submittedPayload(senderName, prompt, options);
  if (harness === undefined) {
    try {
      await deps.sendText(agent.paneId, literalPayload);
    } catch (error) {
      throw new SubmitNotSentError(name, error);
    }
    if (options.textOnly) return;
    try {
      await deps.pressEnter(agent.paneId);
    } catch (error) {
      throw asAssumedFilled(name, error);
    }
    return;
  }
  let textWritten = false;
  try {
    const requestedComposerWaitMilliseconds =
      options.composerWaitMilliseconds ?? RESIDENT_COMPOSER_TIMEOUT_MS;
    const quiescenceComposerDeadline =
      deps.now() + requestedComposerWaitMilliseconds;
    // A resident draft observed here is genuine held business and earns the
    // full requested wait; anything else that never resolves within the
    // tight recognition bound reports failure there instead of silently
    // riding the long ceiling. The quiescence branch (Codex startup) keeps
    // its own separate, untightened deadline.
    let composerDeadline: number | undefined;
    while (true) {
      if (harness === HARNESS_NAMES.CODEX && options.waitForStartupQuiescence) {
        await waitForSettledCodexComposer(agent, quiescenceComposerDeadline, deps);
      } else if (harness === HARNESS_NAMES.CLAUDE && options.waitForStartupQuiescence) {
        // Same shared shape as Codex's branch above, not a second bespoke
        // sequence: wait for the pane's own startup chrome to stop painting
        // before ever writing into it. See `waitForSettledClaudeComposer`'s
        // doc comment for why this closes DEFECT A.
        await waitForSettledClaudeComposer(agent, quiescenceComposerDeadline, deps);
      } else if (harness === HARNESS_NAMES.OPENCODE && options.waitForStartupQuiescence) {
        // Same shared shape again: a fresh-pane startup allowance belongs to
        // every harness, not just the one that happened to wedge first.
        await waitForSettledOpenCodeComposer(agent, quiescenceComposerDeadline, deps);
      } else {
        composerDeadline ??= await resolveComposerWaitDeadline(
          agent,
          harness,
          requestedComposerWaitMilliseconds,
          deps,
        );
        await waitForRecognizedComposer(agent, harness, composerDeadline, deps);
      }
      const guardedFrame =
        harness === HARNESS_NAMES.CODEX && options.waitForStartupQuiescence
          ? await observeCodexStartupFrame(agent, deps)
          : undefined;
      const guarded =
        guardedFrame?.snapshot ??
        (await observeSupportedScreen(agent, harness, deps));
      if (guarded.activeComposer.state === "draft") {
        // The held lock settles exclusive composer ownership: text found now
        // is flushed — submitted through the same bounded Enter transaction —
        // never overwritten, and never a release-and-retry condition.
        const { clearance, bounds } = enterUntilEmptyTransactionFor(harness);
        await pressEnterUntilEmptyTextbox(
          agent,
          guarded.activeComposer.text,
          clearance,
          deps,
          bounds,
        );
        continue;
      }
      if (
        guarded.activeComposer.state === "empty" &&
        guardedFrame?.activeTurn !== true
      ) {
        if (harness === HARNESS_NAMES.CODEX) {
          const preWrite =
            guardedFrame ??
            (await observeCodexScreenWithRecentPrompts(agent, deps));
          if (
            !isSupportedComposerEmpty(HARNESS_NAMES.CODEX, preWrite.visibleAnsi)
          ) {
            continue;
          }
        }
        break;
      }
      if (guarded.activeComposer.state === "unavailable") {
        throw new Error("active bottom composer became unobservable");
      }
      const remaining =
        (composerDeadline ?? quiescenceComposerDeadline) - deps.now();
      if (remaining <= 0) {
        throw new Error(
          "active composer did not become writable before the composer " +
            "deadline; nothing was written",
        );
      }
      await deps.sleep(Math.min(RESIDENT_COMPOSER_POLL_MS, remaining));
    }
    await deps.sendText(agent.paneId, literalPayload);
    textWritten = true;
    // Step 3 is a best-effort WAIT before this court presses Enter — it
    // exists only to stop Enter landing too early, on a still-empty
    // composer. It is NOT a gate on whether to press: by now sendText has
    // already happened, so the composer is ours (the pre-write resident-draft
    // check already ran, before the write) and holds either our payload or
    // nothing — pressing Enter submits the former and does nothing to the
    // latter, so a failed confirmation is never a reason to withhold it. A
    // freshly spawned pane still painting its own startup chrome is exactly
    // where this WAIT can time out; swallowing that failure here (rather
    // than letting it propagate and skip step 5 entirely) is what stops a
    // written-but-never-submitted payload being stranded with no retry.
    try {
      await confirmPayloadWritten(agent, harness, name, deps);
    } catch {
      // Recorded as a delay only, never as a refusal to press — step 5 below
      // is the authoritative, always-reached evidence of whether the
      // payload actually submitted.
    }
    if (options.textOnly) return;
    const { clearance, bounds } = enterUntilEmptyTransactionFor(harness);
    await pressEnterUntilEmptyTextbox(
      agent,
      literalPayload,
      clearance,
      deps,
      bounds,
    );
  } catch (error) {
    if (!textWritten && !(error instanceof SubmitAssumedFilledError)) {
      throw new SubmitNotSentError(name, error);
    }
    throw asAssumedFilled(name, error);
  }
}
