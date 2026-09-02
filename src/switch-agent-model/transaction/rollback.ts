import {
  type LaunchRecipe,
  type SessionCandidate,
} from "../../session/session.contracts.ts";
import { buildResumeArgv } from "../../harness-routing/harness.ts";
import type { AgentStartEvidence } from "../../herdr/herdr-create.contracts.ts";
import { errorText } from "../../shared-policy/error-text.ts";
import type { PhaseLog } from "./phase-log.ts";
import {
  type SwitchTransactionDeps,
  type SwitchTransactionInput,
  type SwitchTransactionResult,
} from "./transaction.types.ts";
import { verifyRunningRecipe } from "./recipe-verification.ts";
import { checkPreservedBytes } from "./persistence.ts";
import { startFailureOwnershipIsAmbiguous } from "./transaction-failure.ts";

export async function rollBackToPrevious(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
  log: PhaseLog,
  previous: LaunchRecipe,
  target: LaunchRecipe,
  sessionId: string,
  targetState: AgentStartEvidence | undefined,
  failureReason: string,
  candidates?: readonly SessionCandidate[],
): Promise<SwitchTransactionResult> {
  const base = {
    spawnEvidenceChanged: false,
    phases: log.events,
    previous,
    target,
    sessionId,
    startEvidence: targetState,
  };
  if (targetState !== undefined) {
    try {
      await deps.closeAgent({
        tabId: targetState.tabId,
        paneId: targetState.agentPaneId ?? targetState.rootPaneId,
      });
      log.ok("close-target-state", targetState.tabId);
    } catch (error) {
      log.failed("close-target-state", errorText(error));
      // The target close was never confirmed and resume-previous was never
      // attempted, so there is no positive/completed rollback side to
      // default to — report the transaction as failed rather than guessing
      // pane ownership.
      return {
        ...base,
        outcome: "target-failed/rollback-failed",
        identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
        reason:
          `${failureReason}; the target state could not be closed, so pane ownership ` +
          `is unknown: ${errorText(error)}`,
      };
    }
  }

  let restored: AgentStartEvidence;
  try {
    restored = await deps.startAgent(input.agentName, {
      cwd: input.spawn.cwd,
      argv: buildResumeArgv(previous, sessionId),
    });
    log.ok("resume-previous", restored.phase);
  } catch (error) {
    const ownershipAmbiguous = startFailureOwnershipIsAmbiguous(error);
    log.failed("resume-previous", errorText(error));
    // An ambiguous-ownership resume failure may already own the exact
    // previous pane: the same "assume it happened, don't repeat the action"
    // default as the main switch's own start-target failure. A definite
    // resume failure has no positive rollback side and is reported failed.
    return {
      ...base,
      outcome: ownershipAmbiguous
        ? "target-failed/rollback-restored"
        : "target-failed/rollback-failed",
      identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
      reason: `${failureReason}; rollback resume failed: ${errorText(error)}`,
    };
  }

  const restoredPaneId = restored.agentPaneId ?? restored.rootPaneId;
  try {
    return await deps.withRecipientPaneLock(restoredPaneId, async () => {
      let verified;
      try {
        verified = await verifyRunningRecipe(
          input,
          deps,
          previous,
          sessionId,
          candidates,
          true,
        );
      } catch (error) {
        log.failed("verify-previous", errorText(error));
        return {
          ...base,
          outcome: "target-failed/rollback-failed",
          identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
          reason: `${failureReason}; rollback verification failed: ${errorText(error)}`,
        };
      }
      if (!verified.ok) {
        log.failed("verify-previous", verified.reason);
        return {
          ...base,
          outcome: "target-failed/rollback-failed",
          identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
          reason: `${failureReason}; rollback is unverified: ${verified.reason}`,
        };
      }
      log.ok("verify-previous", verified.effortEvidence);
      const preserved = await checkPreservedBytes(input, deps, log);
      // A preservation probe that affirmatively disagrees is real evidence
      // of drift, not an unresolved observation — it never defaults to the
      // positive "restored" side.
      return {
        ...base,
        outcome: preserved
          ? "target-failed/rollback-restored"
          : "target-failed/rollback-failed",
        identityAndTreeUnchanged: preserved,
        reason: preserved
          ? failureReason
          : `${failureReason}; the rollback resumed the previous recipe, but identity or ` +
            `tree bytes could not be proven unchanged`,
        effortEvidence: verified.effortEvidence,
        startEvidence: restored,
      };
    });
  } catch (error) {
    log.failed(
      "verify-previous",
      `replacement pane lock failed: ${errorText(error)}`,
    );
    // The resume itself succeeded, but the pane lock needed to verify it
    // never acquired, so restoration was never confirmed — there is no
    // positive rollback side to default to here. Report failed rather than
    // reaching a third verdict by fallback.
    return {
      ...base,
      outcome: "target-failed/rollback-failed",
      identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
      reason:
        `${failureReason}; rollback owns pane "${restoredPaneId}", but its continuous ` +
        `recipient lock failed: ${errorText(error)}`,
      startEvidence: restored,
    };
  }
}
