import type { SpawnSpec } from "../../agentdata/spawn-data-contracts.ts";
import type {
  LaunchRecipe,
  SessionCandidate,
} from "../../session/session.contracts.ts";
import type { CapabilityEvidence } from "../../harness-routing/policy/capabilities.ts";
import type { AgentStartEvidence } from "../../herdr/herdr-create.contracts.ts";
import { errorText } from "../../shared-policy/error-text.ts";
import { checkPreservedBytes, readBackSpawnEvidence } from "./persistence.ts";
import { PhaseLog } from "./phase-log.ts";
import { verifyRunningRecipe } from "./recipe-verification.ts";
import { rollBackToPrevious } from "./rollback.ts";
import type {
  SwitchTransactionDeps,
  SwitchTransactionInput,
  SwitchTransactionResult,
  Verification,
} from "./transaction.types.ts";

export async function verifyAndPersistTarget(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
  log: PhaseLog,
  previous: LaunchRecipe,
  target: LaunchRecipe,
  sessionId: string,
  started: AgentStartEvidence,
  targetCapability: CapabilityEvidence | undefined,
  candidates?: readonly SessionCandidate[],
): Promise<SwitchTransactionResult> {
  let verified: Verification;
  try {
    verified = await verifyRunningRecipe(
      input,
      deps,
      target,
      sessionId,
      candidates,
      true,
    );
  } catch (error) {
    const reason = `target verification failed: ${errorText(error)}`;
    log.failed("verify-target", reason);
    return rollBackToPrevious(
      input,
      deps,
      log,
      previous,
      target,
      sessionId,
      started,
      reason,
      candidates,
    );
  }
  if (!verified.ok) {
    log.failed("verify-target", verified.reason);
    if (
      verified.code === "draft-ownership" ||
      verified.code === "readiness-exhausted"
    ) {
      const ownershipReason =
        verified.code === "draft-ownership"
          ? "the target pane acquired a resident draft before switch verification"
          : "the target pane remained transiently unverifiable through the readiness window";
      // Verification never confirmed the target and the spawn record was
      // never persisted, so there is no positive/"switched" side to default
      // to — report the transaction as failed rather than guessing, while
      // deliberately not rolling back a pane that may still be a live draft.
      return {
        outcome: "target-failed/rollback-failed",
        spawnEvidenceChanged: false,
        identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
        phases: log.events,
        previous,
        target,
        sessionId,
        startEvidence: started,
        reason: `${ownershipReason}; it was preserved without rollback: ${verified.reason}`,
      };
    }
    return rollBackToPrevious(
      input,
      deps,
      log,
      previous,
      target,
      sessionId,
      started,
      `the target is unverified: ${verified.reason}`,
      candidates,
    );
  }
  log.ok("verify-target", verified.effortEvidence);

  const updated: SpawnSpec = {
    ...input.spawn,
    model: target.model,
    effort: target.effort,
    session_id: sessionId,
    switched_at: deps.now().toISOString(),
    switched_from_model: previous.model,
    ...(targetCapability === undefined ? {} : { capability: targetCapability }),
  };
  try {
    await deps.persistSpawnSpec(updated);
    log.ok("persist-spawn", target.model);
  } catch (error) {
    log.failed("persist-spawn", errorText(error));
    // The write itself is a known failure, not an unresolved observation —
    // report the transaction as failed rather than assuming completion.
    return {
      outcome: "target-failed/rollback-failed",
      spawnEvidenceChanged: await readBackSpawnEvidence(
        deps,
        updated,
        input.spawn,
        log,
      ),
      identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
      phases: log.events,
      previous,
      target,
      sessionId,
      effortEvidence: verified.effortEvidence,
      startEvidence: started,
      reason: `${input.agentName} is running the target recipe but its spawn evidence could not be persisted: ${errorText(error)}`,
    };
  }

  const spawnEvidenceChanged = await readBackSpawnEvidence(
    deps,
    updated,
    input.spawn,
    log,
  );
  const preserved = await checkPreservedBytes(input, deps, log);
  // The spawn write itself already succeeded (no exception above); only the
  // independent readback of that write can come back unresolved
  // (`"unknown"`), never a fact that it failed. An unresolved readback
  // structurally defaults to the positive/"switched" side rather than a
  // third verdict — a caller needing certainty re-reads spawnEvidenceChanged
  // and identityAndTreeUnchanged directly. A readback or preservation probe
  // that affirmatively disagrees (`false`) is real evidence, not
  // uncertainty, and never defaults to "switched".
  const switched = spawnEvidenceChanged !== false && preserved;
  return {
    outcome: switched ? "switched" : "target-failed/rollback-failed",
    spawnEvidenceChanged,
    identityAndTreeUnchanged: preserved,
    phases: log.events,
    previous,
    target,
    sessionId,
    effortEvidence: verified.effortEvidence,
    startEvidence: started,
    ...(switched
      ? {}
      : {
          reason:
            spawnEvidenceChanged === false
              ? `${input.agentName} is running the target recipe, but the original spawn evidence remains unchanged`
              : spawnEvidenceChanged === "unknown"
                ? `${input.agentName} is running the target recipe, but the stored spawn evidence is unreadable or foreign`
                : `${input.agentName} is running the target recipe, but its identity or tree bytes could not be proven unchanged`,
        }),
  };
}
