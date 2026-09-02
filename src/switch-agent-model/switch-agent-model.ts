import type {
  AgentStatusCapture,
  SwitchRecipientInspection,
} from "./transaction/transaction-contracts.ts";
import { SessionService } from "../session/session.service.ts";
import type {
  LaunchRecipe,
  SessionCandidate,
} from "../session/session.contracts.ts";
import {
  buildResumeArgv,
  HARNESSES,
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
} from "../harness-routing/harness.ts";
import { evaluateFinalCapability } from "../harness-routing/policy/capabilities.ts";
import type { AgentStartEvidence } from "../herdr/herdr-create.contracts.ts";
import {
  type SwitchPhase,
  type SwitchRefusalCode,
  type SwitchTransactionDeps,
  type SwitchTransactionInput,
  type SwitchTransactionResult,
} from "./transaction/transaction.types.ts";
import { PhaseLog } from "./transaction/phase-log.ts";
import {
  cwdMismatchReason,
  runningCwdMatches,
} from "./transaction/recipe-verification.ts";
import { startFailureOwnershipIsAmbiguous } from "./transaction/transaction-failure.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { checkPreservedBytes } from "./transaction/persistence.ts";
import { rollBackToPrevious } from "./transaction/rollback.ts";
import { verifyAndPersistTarget } from "./transaction/target-commit.ts";
import { Injectable } from "@nestjs/common";
import { RecipientPaneLockService } from "../shared-policy/recipient-pane-lock.service.ts";
import { codexTextboxClearance } from "../herdr/herdr-codex.service.ts";
import {
  getPaneProcessInfo,
  resolveAgent,
} from "../herdr/herdr-runtime.service.ts";
import {
  namedRecipientIdentityText,
  sameNamedRecipientIdentity,
} from "../herdr/herdr-identity.service.ts";
import { HerdrClientService } from "../herdr/herdr-client.ts";
import {
  CodexScreenObservationError,
  observeSupportedScreen,
  readRecentAgentAnsi,
  readRecentCodexAgentAnsi,
  readVisibleAgentAnsi,
  readVisibleAgentText,
  sleep,
  supportedComposerHarness,
  type SupportedScreenObservationDeps,
} from "../herdr/herdr-screen.service.ts";
import type {
  SupportedAgentScreenSnapshot,
  SupportedComposerHarness,
} from "../codex-screen/composer/composer.types.ts";
import { pressEnter, pressPaneKey, sendText } from "../herdr/herdr-client.ts";
import { pressEnterUntilEmptyTextbox } from "../herdr/herdr-send.service.ts";
import {
  agentStatusAcceptsInput,
  type HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";

const SESSION = new SessionService();
const isFullSessionId = SESSION.isFullSessionId.bind(SESSION);
const parseCodexStatusSession = SESSION.parseCodexStatusSession.bind(SESSION);
const parseStatusFields = SESSION.parseStatusFields.bind(SESSION);
const resolveClaudeSession = SESSION.resolveClaudeSession.bind(SESSION);
const resolveCodexSession = SESSION.resolveCodexSession.bind(SESSION);
const validateSwitchTarget = SESSION.validateSwitchTarget.bind(SESSION);

function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}
const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();

export async function switchAgentModel(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
): Promise<SwitchTransactionResult> {
  const log = new PhaseLog();
  const refuse = (
    phase: SwitchPhase,
    code: SwitchRefusalCode,
    reason: string,
  ): SwitchTransactionResult => {
    log.failed(phase, reason);
    return {
      outcome: "refused-before-close",
      spawnEvidenceChanged: false,
      identityAndTreeUnchanged: true,
      phases: log.events,
      reason,
      code,
    };
  };

  const { spawn } = input;
  if (
    spawn.harness_executable !== undefined ||
    spawn.passthrough_argv !== undefined
  ) {
    return refuse(
      "validate-recipe",
      "custom-recipe",
      `${input.agentName} was spawned from a custom harness recipe, which has no exact-resume form`,
    );
  }
  if (!isHarness(spawn.harness)) {
    return refuse(
      "validate-recipe",
      "unsupported-recipe",
      `stored harness "${spawn.harness}" is not a supported harness`,
    );
  }
  if (spawn.cwd.trim() === "") {
    return refuse(
      "validate-recipe",
      "unsupported-recipe",
      `${input.agentName} has no registered cwd to verify a resume against`,
    );
  }
  const previous: LaunchRecipe = {
    harness: spawn.harness,
    model: spawn.model,
    effort: spawn.effort,
  };
  log.ok("validate-recipe", `${previous.harness}:${previous.model}`);

  const validated = validateSwitchTarget(previous, input.request);
  if (!validated.ok) {
    return refuse("validate-target", "unsupported-target", validated.message);
  }
  const target = validated.target;
  const targetCapability =
    spawn.capability === undefined
      ? undefined
      : evaluateFinalCapability({
          harness: target.harness,
          model: target.model,
        });
  if (targetCapability?.kind === "refuse") {
    return refuse(
      "validate-target",
      "unsupported-target",
      targetCapability.reason,
    );
  }
  log.ok("validate-target", `${target.model}@${target.effort}`);

  let inspection: SwitchRecipientInspection;
  try {
    inspection = await deps.inspectRecipient(input.agentName, spawn.cwd);
  } catch (error) {
    return refuse(
      "inspect-recipient",
      "recipient-refused",
      `recipient inspection failed: ${errorText(error)}`,
    );
  }
  if (inspection.outcome === "refused") {
    return refuse(
      "inspect-recipient",
      "recipient-refused",
      `${inspection.code}: ${inspection.reason}`,
    );
  }
  if (inspection.harness !== runtimeHarness(previous.harness)) {
    return refuse(
      "inspect-recipient",
      "recipient-refused",
      `running harness "${inspection.harness}" is not compatible with the registered harness "${previous.harness}"`,
    );
  }
  const recipient = inspection.agent;
  log.ok("inspect-recipient", recipient.paneId);

  let capture: AgentStatusCapture;
  try {
    capture = await deps.captureStatus(recipient, inspection.harness);
  } catch (error) {
    return refuse(
      "resolve-session",
      "session-unprovable",
      `status capture failed: ${errorText(error)}`,
    );
  }
  if (capture.outcome !== "captured") {
    return refuse(
      "resolve-session",
      "session-unprovable",
      `status capture ${capture.outcome}: ${capture.reason}`,
    );
  }

  let candidates: readonly SessionCandidate[] | undefined;
  if (deps.listSessionCandidates !== undefined) {
    try {
      candidates = await deps.listSessionCandidates(
        runtimeHarness(previous.harness),
        spawn.cwd,
      );
    } catch (error) {
      return refuse(
        "resolve-session",
        "session-unprovable",
        `session candidates are unreadable: ${errorText(error)}`,
      );
    }
  }

  const storedSessionId = isFullSessionId(spawn.session_id)
    ? spawn.session_id.trim().toLowerCase()
    : undefined;
  let evidence;
  if (runtimeHarness(previous.harness) === HARNESS_NAMES.CODEX) {
    const displayedSession = parseCodexStatusSession(capture.text);
    const codexCandidates =
      storedSessionId === undefined
        ? candidates
        : [
            ...(candidates ?? []),
            ...((candidates ?? []).some(
              (candidate) => candidate.id.toLowerCase() === storedSessionId,
            )
              ? []
              : [{ id: storedSessionId, cwd: spawn.cwd }]),
          ];
    if (displayedSession !== null && isFullSessionId(displayedSession)) {
      evidence = {
        ok: true as const,
        sessionId: displayedSession.trim().toLowerCase(),
      };
    } else if (codexCandidates === undefined || codexCandidates.length === 0) {
      return refuse(
        "resolve-session",
        "session-unprovable",
        "Codex exposes only a truncated session prefix and no candidates were supplied",
      );
    } else {
      evidence = resolveCodexSession(capture.text, codexCandidates, spawn.cwd);
    }
  } else {
    const corroboration =
      candidates !== undefined && candidates.length > 0
        ? candidates
        : undefined;
    evidence = resolveClaudeSession(capture.text, spawn.cwd, corroboration);
  }
  if (!evidence.ok) {
    return refuse(
      "resolve-session",
      "session-unprovable",
      `${evidence.reason}: ${evidence.message}`,
    );
  }
  if (storedSessionId !== undefined && evidence.sessionId !== storedSessionId) {
    return refuse(
      "resolve-session",
      "session-unprovable",
      `live session "${evidence.sessionId}" does not match stored session "${storedSessionId}"`,
    );
  }
  const sessionId = evidence.sessionId;
  const currentCwd = parseStatusFields(capture.text).cwd;
  if (currentCwd === undefined) {
    return refuse(
      "resolve-session",
      "session-unprovable",
      "the status panel exposes no cwd",
    );
  }
  const cwdEquivalence = await runningCwdMatches(
    currentCwd,
    spawn.cwd,
    previous.harness,
    sessionId,
    candidates,
    deps.resolvePath,
  );
  if (!cwdEquivalence.matches) {
    return refuse(
      "resolve-session",
      "session-unprovable",
      cwdMismatchReason(currentCwd, spawn.cwd, cwdEquivalence),
    );
  }
  log.ok(
    "resolve-session",
    storedSessionId === undefined ? "status" : "stored-corroborated",
  );

  try {
    await deps.closeAgent({ tabId: recipient.tabId, paneId: recipient.paneId });
    log.ok("close-current", recipient.tabId || recipient.paneId);
  } catch (error) {
    log.failed("close-current", errorText(error));
    // The close was never confirmed and the target was never attempted, so
    // there is no positive/completed side to default to here — assuming
    // "switched" would claim a launch that never happened. Report the
    // transaction as failed rather than inventing a third verdict for the
    // unread pane state.
    return {
      outcome: "target-failed/rollback-failed",
      spawnEvidenceChanged: false,
      identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
      phases: log.events,
      previous,
      target,
      sessionId,
      reason: `closing ${input.agentName} failed, so its pane ownership is unknown: ${errorText(error)}`,
    };
  }

  let started: AgentStartEvidence;
  try {
    started = await deps.startAgent(input.agentName, {
      cwd: spawn.cwd,
      argv: buildResumeArgv(target, sessionId),
    });
    log.ok("start-target", started.phase);
  } catch (error) {
    log.failed("start-target", errorText(error));
    if (startFailureOwnershipIsAmbiguous(error)) {
      // The launch's own ownership of the target pane could not be
      // confirmed, but rolling back now risks closing a pane the target
      // already owns and colliding with the previous agent's resume. Never
      // guess, never double-launch: report the transaction as failed and
      // leave both close-current and start-target un-repeated, the same
      // structural default as an unconfirmed close above.
      return {
        outcome: "target-failed/rollback-failed",
        spawnEvidenceChanged: false,
        identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
        phases: log.events,
        previous,
        target,
        sessionId,
        reason: `the target launch may already own the exact pane: ${errorText(error)}`,
      };
    }
    return rollBackToPrevious(
      input,
      deps,
      log,
      previous,
      target,
      sessionId,
      undefined,
      `the target launch failed: ${errorText(error)}`,
      candidates,
    );
  }

  const targetPaneId = started.agentPaneId ?? started.rootPaneId;
  try {
    return await deps.withRecipientPaneLock(targetPaneId, () =>
      verifyAndPersistTarget(
        input,
        deps,
        log,
        previous,
        target,
        sessionId,
        started,
        targetCapability?.evidence,
        candidates,
      ),
    );
  } catch (error) {
    log.failed(
      "verify-target",
      `replacement pane lock failed: ${errorText(error)}`,
    );
    // The launch itself succeeded, but the lock needed to verify and persist
    // it never acquired, so completion was never confirmed — there is no
    // positive/"switched" side to default to. Report failed rather than
    // reaching a third verdict by fallback.
    return {
      outcome: "target-failed/rollback-failed",
      spawnEvidenceChanged: false,
      identityAndTreeUnchanged: await checkPreservedBytes(input, deps, log),
      phases: log.events,
      previous,
      target,
      sessionId,
      startEvidence: started,
      reason:
        `the target launch owns pane "${targetPaneId}", but its continuous recipient ` +
        `lock failed: ${errorText(error)}`,
    };
  }
}
