import { SessionService } from "../../session/session.service.ts";
import type {
  LaunchRecipe,
  SessionCandidate,
} from "../../session/session.contracts.ts";
const SESSION = new SessionService();
const parseStatusFields = SESSION.parseStatusFields.bind(SESSION);
const resolveClaudeSession = SESSION.resolveClaudeSession.bind(SESSION);
const resolveCodexSession = SESSION.resolveCodexSession.bind(SESSION);
import {
  effortToken,
  HARNESS_NAMES,
  runtimeHarness,
  type Harness,
} from "../../harness-routing/harness.ts";
import type { AgentStatusCapture, SwitchRecipientInspection } from "./transaction-contracts.ts";
import { errorText } from "../../shared-policy/error-text.ts";
import {
  parseStatusEffort,
  statusEffortMatches,
  statusModelMatches,
} from "./status-evidence.ts";
import type {
  SwitchTransactionDeps,
  SwitchTransactionInput,
  Verification,
} from "./transaction.types.ts";

export const TARGET_VERIFICATION_READINESS_ATTEMPTS = 61;
export const TARGET_VERIFICATION_READINESS_DELAY_MS = 250;
export const TARGET_VERIFICATION_READINESS_WINDOW_MS =
  (TARGET_VERIFICATION_READINESS_ATTEMPTS - 1) *
  TARGET_VERIFICATION_READINESS_DELAY_MS;

// A cwd comparison that fails to resolve either path is not the same fact as
// two paths that resolved and genuinely differ — losing that distinction is
// what made a resumable, symlink-spelled agent look like a real mismatch.
// `unresolved` lets every caller report the two cases with a diagnosable,
// distinct reason instead of one conflated "could not be proven" message.
export interface CwdEquivalence {
  matches: boolean;
  unresolved: boolean;
  detail?: string;
}

async function resolvedPathsMatch(
  displayed: string,
  registered: string,
  resolvePath: SwitchTransactionDeps["resolvePath"],
): Promise<CwdEquivalence> {
  const statusPath = displayed.replace(/\s*│\s*$/u, "");
  if (statusPath === registered) return { matches: true, unresolved: false };
  try {
    const [resolvedDisplayed, resolvedRegistered] = await Promise.all([
      resolvePath(statusPath),
      resolvePath(registered),
    ]);
    return {
      matches: resolvedDisplayed === resolvedRegistered,
      unresolved: false,
    };
  } catch (error) {
    return { matches: false, unresolved: true, detail: errorText(error) };
  }
}

async function durableSessionCwdMatches(
  candidates: readonly SessionCandidate[] | undefined,
  sessionId: string,
  registered: string,
  resolvePath: SwitchTransactionDeps["resolvePath"],
): Promise<boolean> {
  const sightings = (candidates ?? []).filter(
    (candidate) => candidate.id.trim().toLowerCase() === sessionId,
  );
  if (
    sightings.length === 0 ||
    sightings.some((candidate) => candidate.cwd === undefined)
  ) {
    return false;
  }
  const resolvedRegistered = await resolvePath(registered).catch(
    () => undefined,
  );
  if (resolvedRegistered === undefined) return false;
  const resolvedCwds = await Promise.all(
    sightings.map((candidate) =>
      resolvePath(candidate.cwd!).catch(() => undefined),
    ),
  );
  return resolvedCwds.every((cwd) => cwd === resolvedRegistered);
}

export async function runningCwdMatches(
  displayed: string,
  registered: string,
  harness: Harness,
  sessionId: string,
  candidates: readonly SessionCandidate[] | undefined,
  resolvePath: SwitchTransactionDeps["resolvePath"],
): Promise<CwdEquivalence> {
  const direct = await resolvedPathsMatch(displayed, registered, resolvePath);
  if (direct.matches) return direct;
  if (
    runtimeHarness(harness) !== HARNESS_NAMES.CODEX ||
    !displayed.includes("…")
  )
    return direct;
  const durable = await durableSessionCwdMatches(
    candidates,
    sessionId,
    registered,
    resolvePath,
  );
  // The durable-session fallback either proves the cwd or it doesn't — it
  // never itself fails to resolve, so a failed fallback carries the direct
  // comparison's own reason (mismatch vs unresolved) forward unchanged.
  return durable ? { matches: true, unresolved: false } : direct;
}

export function cwdMismatchReason(
  displayed: string,
  registered: string,
  equivalence: CwdEquivalence,
): string {
  const base = `running cwd "${displayed}" is not the registered cwd "${registered}"`;
  return equivalence.unresolved
    ? `${base} and could not be proven equivalent: path resolution failed (${equivalence.detail})`
    : base;
}

function isTransientVerificationReadiness(
  inspection: SwitchRecipientInspection,
): boolean {
  const missingLiveHarnessProcess =
    inspection.outcome !== "ready" &&
    inspection.reason.includes("pane has no genuine live harness process");
  const incompletePaneProcessRow =
    inspection.outcome === "refused" &&
    inspection.code === "unresolved" &&
    /^herdr pane process-info: process row \d+ is missing name \/ argv$/u.test(
      inspection.reason,
    );
  return (
    inspection.outcome === "refused" &&
    (inspection.code === "screen-unusable" ||
      inspection.code === "composer-unavailable" ||
      (inspection.code === "unresolved" &&
        (missingLiveHarnessProcess || incompletePaneProcessRow)))
  );
}

async function inspectTargetRecipientWhenReady(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
): Promise<{ inspection: SwitchRecipientInspection; exhausted: boolean }> {
  for (
    let attempt = 1;
    attempt <= TARGET_VERIFICATION_READINESS_ATTEMPTS;
    attempt += 1
  ) {
    const inspection = await deps.inspectRecipient(
      input.agentName,
      input.spawn.cwd,
    );
    if (!isTransientVerificationReadiness(inspection)) {
      return { inspection, exhausted: false };
    }
    if (attempt === TARGET_VERIFICATION_READINESS_ATTEMPTS) {
      return { inspection, exhausted: true };
    }
    await deps.wait(TARGET_VERIFICATION_READINESS_DELAY_MS);
  }
  throw new Error("target verification readiness attempts were not executed");
}

export async function verifyRunningRecipe(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
  recipe: LaunchRecipe,
  sessionId: string,
  candidates?: readonly SessionCandidate[],
  retryReadiness = false,
): Promise<Verification> {
  let inspection: SwitchRecipientInspection;
  let readinessExhausted = false;
  try {
    if (retryReadiness) {
      const readiness = await inspectTargetRecipientWhenReady(input, deps);
      inspection = readiness.inspection;
      readinessExhausted = readiness.exhausted;
    } else {
      inspection = await deps.inspectRecipient(
        input.agentName,
        input.spawn.cwd,
      );
    }
  } catch (error) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `recipient inspection failed after launch: ${errorText(error)}`,
    };
  }
  if (readinessExhausted) {
    return {
      ok: false,
      code: "readiness-exhausted",
      reason:
        `recipient inspection remained transiently unusable across the ` +
        `${TARGET_VERIFICATION_READINESS_WINDOW_MS}ms readiness window ` +
        `(${TARGET_VERIFICATION_READINESS_ATTEMPTS} observations): ` +
        `${inspection.outcome === "refused" ? inspection.reason : "unavailable"}`,
    };
  }
  if (inspection.outcome !== "ready") {
    return {
      ok: false,
      code:
        inspection.outcome === "refused" &&
        inspection.code === "composer-not-empty"
          ? "draft-ownership"
          : "verification-failed",
      reason: `${input.agentName} is not verifiable after launch: ${inspection.reason}`,
    };
  }
  if (inspection.harness !== runtimeHarness(recipe.harness)) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `launched harness "${inspection.harness}" is not compatible with the recipe harness "${recipe.harness}"`,
    };
  }
  let capture: AgentStatusCapture;
  try {
    capture = await deps.captureStatus(inspection.agent, inspection.harness);
  } catch (error) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `status capture failed after launch: ${errorText(error)}`,
    };
  }
  if (capture.outcome !== "captured") {
    return {
      ok: false,
      code:
        capture.outcome === "refused" && capture.code === "composer-not-empty"
          ? "draft-ownership"
          : "verification-failed",
      reason: `no status evidence after launch: ${capture.reason}`,
    };
  }
  const evidence =
    runtimeHarness(recipe.harness) === HARNESS_NAMES.CODEX
      ? resolveCodexSession(
          capture.text,
          [{ id: sessionId, cwd: input.spawn.cwd }],
          input.spawn.cwd,
        )
      : resolveClaudeSession(capture.text);
  if (!evidence.ok) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `session unproven after launch: ${evidence.message}`,
    };
  }
  if (evidence.sessionId !== sessionId) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `resumed session "${evidence.sessionId}" is not the exact session "${sessionId}"`,
    };
  }
  const fields = parseStatusFields(capture.text);
  if (fields.cwd === undefined) {
    return {
      ok: false,
      code: "verification-failed",
      reason: "the status panel exposes no cwd after launch",
    };
  }
  if (fields.model === undefined) {
    return {
      ok: false,
      code: "verification-failed",
      reason: "the status panel exposes no model after launch",
    };
  }
  if (!statusModelMatches(fields.model, recipe.model)) {
    return {
      ok: false,
      code: "verification-failed",
      reason: `running model "${fields.model}" is not the recipe model "${recipe.model}"`,
    };
  }
  const cwdEquivalence = await runningCwdMatches(
    fields.cwd,
    input.spawn.cwd,
    recipe.harness,
    sessionId,
    candidates,
    deps.resolvePath,
  );
  if (!cwdEquivalence.matches) {
    return {
      ok: false,
      code: "verification-failed",
      reason: cwdMismatchReason(fields.cwd, input.spawn.cwd, cwdEquivalence),
    };
  }
  const shownEffort = parseStatusEffort(capture.text);
  if (shownEffort === undefined) {
    return { ok: true, effortEvidence: "launch-argv" };
  }
  if (!statusEffortMatches(shownEffort, recipe.harness, recipe.effort)) {
    return {
      ok: false,
      code: "verification-failed",
      reason:
        `running effort "${shownEffort}" is not the recipe effort ` +
        `${recipe.effort} ("${effortToken(recipe.harness, recipe.effort)}")`,
    };
  }
  return { ok: true, effortEvidence: "status" };
}
