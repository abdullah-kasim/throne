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
import type { AgentStatusCapture } from "./transaction/transaction-contracts.ts";
import { PhaseLog } from "./transaction/phase-log.ts";
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
import { PRESS_ENTER_UNTIL_EMPTY_BOUNDS } from "../herdr/herdr-send.helpers.ts";
import {
  agentStatusAcceptsInput,
  type HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";
const RECIPIENT_PANE_LOCK = new RecipientPaneLockService();

function statusCaptureErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const STATUS_COMMAND = "/status";
export const STATUS_CAPTURE_SETTLE_MS = 250;
export const STATUS_CAPTURE_POLL_MS = 250;
export const STATUS_CAPTURE_TIMEOUT_MS = 15_000;

export type StatusCaptureRefusal =
  | "unresolved"
  | "identity-changed"
  | "unexpected-harness"
  | "screen-unusable"
  | "composer-not-empty";

export interface CaptureAgentStatusDeps extends SupportedScreenObservationDeps {
  resolveAgent: (name: string) => Promise<HerdrAgent>;
  withRecipientPaneLock: RecipientPaneLockService["withRecipientPaneLock"];
  readVisibleAgentText: typeof readVisibleAgentText;
  readRecentAgentAnsi: typeof readRecentAgentAnsi;
  readRecentCodexAgentAnsi?: typeof readRecentCodexAgentAnsi;
  sendText: typeof sendText;
  pressEnter: typeof pressEnter;
  pressPaneKey: typeof pressPaneKey;
  sleep: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface CaptureAgentStatusOptions {
  timeoutMs?: number;
}

export const REAL_CAPTURE_AGENT_STATUS_DEPS: CaptureAgentStatusDeps = {
  resolveAgent,
  getPaneProcessInfo,
  readVisibleAgentAnsi,
  readRecentAgentAnsi,
  readRecentCodexAgentAnsi,
  readVisibleAgentText,
  withRecipientPaneLock:
    RECIPIENT_PANE_LOCK.withRecipientPaneLock.bind(RECIPIENT_PANE_LOCK),
  sendText,
  pressEnter,
  pressPaneKey,
  sleep,
  now: Date.now,
};

export async function captureAgentStatus(
  recipient: HerdrAgent,
  expectedHarness: SupportedComposerHarness,
  overlayCaptured: (text: string) => boolean,
  deps: CaptureAgentStatusDeps = REAL_CAPTURE_AGENT_STATUS_DEPS,
  options: CaptureAgentStatusOptions = {},
): Promise<AgentStatusCapture> {
  try {
    return await deps.withRecipientPaneLock(recipient.paneId, async () =>
      captureLockedAgentStatus(
        recipient,
        expectedHarness,
        overlayCaptured,
        deps,
        options,
      ),
    );
  } catch (error) {
    // The pane lock itself could not be acquired, so status was never
    // observed. That is unresolved, not a fact about the recipient.
    return {
      outcome: "refused",
      code: "unresolved",
      reason: statusCaptureErrorText(error),
    };
  }
}

async function captureLockedAgentStatus(
  recipient: HerdrAgent,
  expectedHarness: SupportedComposerHarness,
  overlayCaptured: (text: string) => boolean,
  deps: CaptureAgentStatusDeps,
  options: CaptureAgentStatusOptions,
): Promise<AgentStatusCapture> {
  const recipientName = recipient.name ?? recipient.terminalId;
  let agent: HerdrAgent;
  try {
    agent = await deps.resolveAgent(recipientName);
  } catch (error) {
    return {
      outcome: "refused",
      code: "unresolved",
      reason: statusCaptureErrorText(error),
    };
  }
  if (!sameNamedRecipientIdentity(recipient, agent)) {
    return {
      outcome: "refused",
      code: "identity-changed",
      reason:
        `recipient identity changed while waiting for the pane lock: ` +
        `expected ${namedRecipientIdentityText(recipient)}, ` +
        `observed ${namedRecipientIdentityText(agent)}`,
    };
  }
  if (supportedComposerHarness(agent.agent) !== expectedHarness) {
    return {
      outcome: "refused",
      code: "unexpected-harness",
      reason:
        `recipient "${agent.name}" runs harness ` +
        `${JSON.stringify(agent.agent)}, not the expected ` +
        `${JSON.stringify(expectedHarness)}`,
    };
  }

  let snapshot: SupportedAgentScreenSnapshot;
  try {
    snapshot = await observeSupportedScreen(agent, expectedHarness, deps);
  } catch (error) {
    return {
      outcome: "refused",
      code: "screen-unusable",
      reason: statusCaptureErrorText(error),
    };
  }
  if (snapshot.activeComposer.state === "unavailable") {
    return {
      outcome: "refused",
      code: "screen-unusable",
      reason:
        `recipient "${agent.name}" renders no recognized composer; ` +
        `${STATUS_COMMAND} was never typed`,
    };
  }
  if (snapshot.activeComposer.state !== "empty") {
    return {
      outcome: "refused",
      code: "composer-not-empty",
      reason:
        `recipient "${agent.name}" holds a ` +
        `${snapshot.activeComposer.state} composer; ` +
        `${STATUS_COMMAND} was never typed`,
    };
  }

  await deps.sendText(agent.paneId, STATUS_COMMAND);
  await deps.sleep(STATUS_CAPTURE_SETTLE_MS);
  if (expectedHarness === HARNESS_NAMES.CODEX) {
    await pressEnterUntilEmptyTextbox(
      agent,
      STATUS_COMMAND,
      codexTextboxClearance(),
      { ...deps, now: deps.now ?? Date.now },
      PRESS_ENTER_UNTIL_EMPTY_BOUNDS,
    );
  } else {
    await deps.pressEnter(agent.paneId);
  }

  let remaining = options.timeoutMs ?? STATUS_CAPTURE_TIMEOUT_MS;
  let text = await deps.readVisibleAgentText(agent.paneId);
  while (!overlayCaptured(text)) {
    if (remaining <= 0) {
      const abandoned = await settleAfterStatusCapture(
        agent,
        expectedHarness,
        deps,
      );
      const timedOut =
        `${STATUS_COMMAND} was submitted to "${agent.name}" but no ` +
        `status evidence rendered within ` +
        `${options.timeoutMs ?? STATUS_CAPTURE_TIMEOUT_MS}ms`;
      return {
        outcome: "refused",
        code: "screen-unusable",
        reason: abandoned.settled
          ? `${timedOut}; the pane was cleaned up and re-observed empty`
          : `${timedOut}; ${abandoned.evidence}`,
      };
    }
    const step = Math.min(STATUS_CAPTURE_POLL_MS, remaining);
    await deps.sleep(step);
    remaining -= step;
    text = await deps.readVisibleAgentText(agent.paneId);
  }

  const settled = await settleAfterStatusCapture(agent, expectedHarness, deps);
  if (!settled.settled) {
    return {
      outcome: "refused",
      code: "screen-unusable",
      reason:
        `status evidence was captured from "${agent.name}" but ` +
        `${settled.evidence}`,
    };
  }
  return { outcome: "captured", text };
}

type StatusCaptureSettle =
  { settled: true } | { settled: false; evidence: string };

async function settleAfterStatusCapture(
  agent: HerdrAgent,
  expectedHarness: SupportedComposerHarness,
  deps: CaptureAgentStatusDeps,
): Promise<StatusCaptureSettle> {
  if (expectedHarness === HARNESS_NAMES.CLAUDE) {
    try {
      await deps.pressPaneKey(agent.paneId, "Escape");
    } catch (error) {
      return {
        settled: false,
        evidence: `the measured Escape cleanup failed: ${statusCaptureErrorText(error)}`,
      };
    }
    await deps.sleep(STATUS_CAPTURE_SETTLE_MS);
  }

  let after: SupportedAgentScreenSnapshot;
  try {
    after = await observeSupportedScreen(agent, expectedHarness, deps);
  } catch (error) {
    return {
      settled: false,
      evidence: `the pane could not be re-observed afterwards: ${statusCaptureErrorText(error)}`,
    };
  }
  if (after.activeComposer.state !== "empty") {
    return {
      settled: false,
      evidence: `its composer is left "${after.activeComposer.state}"`,
    };
  }
  return { settled: true };
}
