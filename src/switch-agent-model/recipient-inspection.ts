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
import type { AgentStartEvidence } from "../herdr/herdr-create.contracts.ts";
import {
  type SwitchPhase,
  type SwitchRefusalCode,
  type SwitchTransactionDeps,
  type SwitchTransactionInput,
  type SwitchTransactionResult,
} from "./transaction/transaction.types.ts";
import type { SwitchRecipientInspection } from "./transaction/transaction-contracts.ts";
import { PhaseLog } from "./transaction/phase-log.ts";
import { runningCwdMatches } from "./transaction/recipe-verification.ts";
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
const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();

function switchInspectionErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface InspectSwitchRecipientDeps extends SupportedScreenObservationDeps {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  withRecipientPaneLock: RecipientPaneLockService["withRecipientPaneLock"];
  resolvePath: (value: string) => string;
}

export async function inspectSwitchRecipient(
  recipientName: string,
  expectedCwd: string,
  deps: InspectSwitchRecipientDeps,
): Promise<SwitchRecipientInspection> {
  let initial: HerdrAgent;
  try {
    initial = await deps.resolveAgent(recipientName);
  } catch (error) {
    return {
      outcome: "refused",
      code: "unresolved",
      reason: switchInspectionErrorText(error),
    };
  }

  try {
    return await deps.withRecipientPaneLock(initial.paneId, async () =>
      inspectLockedSwitchRecipient(recipientName, expectedCwd, initial, deps),
    );
  } catch (error) {
    // The pane lock itself could not be acquired, so the recipient was never
    // observed. That is unresolved, not a fact about the recipient — refuse
    // rather than assume readiness, since readiness gates closing a live pane.
    return {
      outcome: "refused",
      code: "unresolved",
      reason: switchInspectionErrorText(error),
    };
  }
}

async function inspectLockedSwitchRecipient(
  recipientName: string,
  expectedCwd: string,
  initial: HerdrAgent,
  deps: InspectSwitchRecipientDeps,
): Promise<SwitchRecipientInspection> {
  let agent: HerdrAgent;
  try {
    agent = await deps.resolveAgent(recipientName);
  } catch (error) {
    return {
      outcome: "refused",
      code: "unresolved",
      reason: switchInspectionErrorText(error),
    };
  }
  if (!sameNamedRecipientIdentity(initial, agent)) {
    return {
      outcome: "refused",
      code: "identity-changed",
      reason:
        `recipient identity changed while waiting for the pane lock: ` +
        `expected ${namedRecipientIdentityText(initial)}, ` +
        `observed ${namedRecipientIdentityText(agent)}`,
    };
  }
  if (!agentStatusAcceptsInput(agent.agentStatus)) {
    return {
      outcome: "refused",
      code: "status-rejects-input",
      reason:
        `recipient "${agent.name}" is ${agent.agentStatus} and does not ` +
        `accept input`,
    };
  }
  let resolvedAgentCwd: string;
  let resolvedExpectedCwd: string;
  try {
    resolvedAgentCwd = deps.resolvePath(agent.cwd);
    resolvedExpectedCwd = deps.resolvePath(expectedCwd);
  } catch (error) {
    // A resolution failure is a fact about the filesystem lookup, not about
    // whether the two cwds denote the same directory — it must refuse
    // loudly with its own reason rather than being conflated with a genuine
    // mismatch or crashing the switch-agent-model command.
    return {
      outcome: "refused",
      code: "cwd-unresolvable",
      reason:
        `recipient "${agent.name}"'s cwd ${JSON.stringify(agent.cwd)} could not be ` +
        `resolved against the expected ${JSON.stringify(expectedCwd)}: ` +
        switchInspectionErrorText(error),
    };
  }
  if (resolvedAgentCwd !== resolvedExpectedCwd) {
    return {
      outcome: "refused",
      code: "cwd-mismatch",
      reason:
        `recipient "${agent.name}" runs in ${JSON.stringify(agent.cwd)}, ` +
        `not the expected ${JSON.stringify(expectedCwd)}`,
    };
  }
  const harness = supportedComposerHarness(agent.agent);
  if (harness === undefined) {
    return {
      outcome: "refused",
      code: "unsupported-harness",
      reason: `harness "${agent.agent}" has no supported composer`,
    };
  }

  let snapshot: SupportedAgentScreenSnapshot;
  try {
    snapshot = await observeSupportedScreen(agent, harness, deps);
  } catch (error) {
    if (
      error instanceof CodexScreenObservationError &&
      error.diagnostic.code === "active-composer-unrecognized"
    ) {
      return {
        outcome: "refused",
        code: "composer-unavailable",
        reason: error.message,
      };
    }
    return {
      outcome: "refused",
      code: "screen-unusable",
      reason: switchInspectionErrorText(error),
    };
  }
  if (snapshot.activeComposer.state === "unavailable") {
    return {
      outcome: "refused",
      code: "composer-unavailable",
      reason: `recipient "${agent.name}" has no verifiable active composer`,
    };
  }
  if (snapshot.activeComposer.state !== "empty") {
    return {
      outcome: "refused",
      code: "composer-not-empty",
      reason:
        `recipient "${agent.name}" holds a ` +
        `${snapshot.activeComposer.state} composer; a switch would destroy it`,
    };
  }
  return { outcome: "ready", agent, harness, snapshot };
}
