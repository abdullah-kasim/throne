import { claudeModFallbackLine } from "./claude-mod-route.ts";
import { ALIVE_TIMEOUT_MILLISECONDS, MESSAGE_ID_PREFIX } from "../../extensions/shared/agent-delivery-contract.ts";
import { isSupportedComposerEmpty } from "../codex-screen/composer/composer.service.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { EXTENSION_DELIVERY_TIMEOUT_MS } from "./herdr-send.types.ts";
import { deliverToPi, piFallbackLine, rememberPiFallback } from "./pi-delivery-client.ts";
import { PaneLockTakenOverError } from "../shared-policy/recipient-pane-lock.service.ts";
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
  const residentRepresentation =
    harness === HARNESS_NAMES.PI
      ? await waitForStableClaudeResidentRepresentation(agent, deps, harness)
      : await waitForStableResidentRepresentation(agent, deps);
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
): Error {
  return error instanceof SubmitAssumedFilledError || error instanceof PaneLockTakenOverError
    ? error
    : new SubmitAssumedFilledError(
        name,
        `post-send interaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error,
      );
}

export const SOCKET_STARTUP_WAIT_MS = 20_000;
const writeToStandardError = (line: string) => {
  process.stderr.write(line);
};
const SOCKET_STARTUP_POLL_MS = 500;

async function waitForTheSocketToAnswer(answering: () => Promise<boolean>, deps: SubmitToAgentDeps): Promise<void> {
  const deadline = deps.now() + SOCKET_STARTUP_WAIT_MS;
  while (!(await answering()) && deps.now() < deadline) {
    await deps.sleep(SOCKET_STARTUP_POLL_MS);
  }
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
): Promise<string | undefined> {
  const name = recipientName(agent);
  const harness = supportedComposerHarness(agent.agent);
  await dismissOpenCodeMessageActionsModal(agent, deps);
  if (options.skipText) {
    try {
      await submitEnterOnlyWhileLocked(agent, deps);
    } catch (error) {
      throw asAssumedFilled(name, error);
    }
    return undefined;
  }
  if (harness === HARNESS_NAMES.PI) {
    const startupCheck = deps.claudeMod;
    if (options.waitForStartupQuiescence && startupCheck !== undefined) {
      const socketPath = await startupCheck.socketOf(name);
      await waitForTheSocketToAnswer(async () => (await startupCheck.alive(socketPath, agent.paneId)) !== undefined, deps);
    }
    const piPayload = submittedPayload(senderName, prompt, options);
    const outcome = await (deps.deliverToPi ?? deliverToPi)(
      piPayload,
      options.composerWaitMilliseconds ?? EXTENSION_DELIVERY_TIMEOUT_MS,
      { paneId: agent.paneId, agentName: name },
      options.messageId,
    );
    if (outcome.kind === "delivered") return piPayload;
    if (outcome.kind === "dropped") throw new SubmitAssumedFilledError(name, outcome.detail);
    if (outcome.kind === "refused") {
      throw new SubmitNotSentError(
        name,
        new Error(`${harness} delivery refused: ${outcome.detail}`),
      );
    }
    if (outcome.kind === "timed-out") {
      throw new SubmitNotSentError(
        name,
        new Error(
          `${harness} delivery got no delivered answer within ${outcome.waitedMs}ms — the ` +
            `extension holds a request while a resident draft is present, and ` +
            `holds it equally while the composer is unreadable. The connection was ` +
            `closed, so nothing will arrive late.`,
        ),
      );
    }
    if (rememberPiFallback(name, options.messageId)) {
      (deps.claudeMod?.log ?? writeToStandardError)(piFallbackLine(name, outcome.detail));
    }
  }
  const claudeMod = deps.claudeMod;
  if (harness === HARNESS_NAMES.CLAUDE && claudeMod !== undefined && (await claudeMod.usesMod(name))) {
    const socketPath = await claudeMod.socketOf(name);
    const answering = async () => (await claudeMod.alive(socketPath, agent.paneId)) !== undefined;
    if (options.waitForStartupQuiescence) await waitForTheSocketToAnswer(answering, deps);
    if (!(await answering())) {
      claudeMod.log(claudeModFallbackLine(name, `no answer on its delivery socket within ${ALIVE_TIMEOUT_MILLISECONDS}ms`));
    } else {
      const modPayload = submittedPayload(senderName, prompt, options);
      const outcome = await deps.deliverThroughExtension(
        modPayload,
        options.composerWaitMilliseconds ?? EXTENSION_DELIVERY_TIMEOUT_MS,
        agent.paneId,
        {
          ...(socketPath === undefined ? {} : { socketPath }),
          ...(options.messageId === undefined ? {} : { requestId: `${MESSAGE_ID_PREFIX}${options.messageId}` }),
        },
      );
      if (outcome.kind === "delivered") return modPayload;
      if (outcome.kind === "dropped") throw new SubmitAssumedFilledError(name, outcome.detail);
      if (outcome.kind === "timed-out" && (await answering())) {
        throw new SubmitNotSentError(
          name,
          new Error(
            `the Claude mod is answering but took no request within ${outcome.waitedMs}ms; it holds messages ` +
              `while a draft is in the composer or a turn is running. The connection was closed and nothing was typed.`,
          ),
        );
      }
      claudeMod.log(
        claudeModFallbackLine(
          name,
          outcome.kind === "timed-out"
            ? `no answer after ${outcome.waitedMs}ms; the connection was closed`
            : outcome.detail,
        ),
      );
    }
    return deps.withRecipientPaneLock(agent.paneId, () =>
      submitToAgentWhileLocked(agent, senderName, prompt, options, { ...deps, claudeMod: undefined }),
    );
  }
  // Keep delivery on the proven send-text + bounded Enter transaction: the
  // herdr agent-prompt primitive can mis-handle queued/draft composer state.
  const literalPayload = submittedPayload(senderName, prompt, options);
  if (harness === undefined) {
    try {
      await deps.sendText(agent.paneId, literalPayload);
    } catch (error) {
      if (error instanceof PaneLockTakenOverError) throw error;
      throw new SubmitNotSentError(name, error);
    }
    if (options.textOnly) return literalPayload;
    try {
      await deps.pressEnter(agent.paneId);
    } catch (error) {
      throw asAssumedFilled(name, error);
    }
    return literalPayload;
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
      if (
        guarded.activeComposer.state === "draft" &&
        options.leaveResidentDraftUnsubmitted === true
      ) {
        throw new Error(
          "a resident draft occupies the composer; nothing was written",
        );
      }
      if (guarded.activeComposer.state === "draft" && harness !== HARNESS_NAMES.PI) {
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
    if (options.textOnly) return literalPayload;
    const { clearance, bounds } = enterUntilEmptyTransactionFor(harness);
    await pressEnterUntilEmptyTextbox(
      agent,
      literalPayload,
      clearance,
      deps,
      bounds,
    );
    return literalPayload;
  } catch (error) {
    if (!textWritten && !(error instanceof SubmitAssumedFilledError) && !(error instanceof PaneLockTakenOverError)) {
      throw new SubmitNotSentError(name, error);
    }
    throw asAssumedFilled(name, error);
  }
}
