import type { SupportedAgentScreenSnapshot } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { isHerdrPaneGone } from "../herdr/herdr-client.ts";
import { sameRecipientPaneIdentity } from "../herdr/herdr-identity.service.ts";
import {
  agentStatusAcceptsInput,
  type AgentStatus,
  type HerdrAgent,
} from "../herdr/herdr-inventory.service.ts";
import { observeSupportedScreen } from "../herdr/herdr-screen.service.ts";
import { recipientName } from "../herdr/herdr-send.helpers.ts";
import {
  SubmitNotSentError,
  defaultSubmitToAgentDeps,
  submitToAgentWhileLocked,
} from "../herdr/herdr-send.service.ts";
import type {
  SubmitToAgentDeps,
  SubmitToAgentOptions,
} from "../herdr/herdr-send.types.ts";
import { errorText } from "../shared-policy/error-text.ts";

export const HARNESS_COMMAND_TYPING_OUTCOMES = {
  APPLIED: "applied",
  SKIPPED_BUSY: "skipped-busy",
  SKIPPED_NOT_CLAUDE: "skipped-not-claude",
  PANE_CLOSED: "pane-closed",
  FAILED: "failed",
} as const;

export type HarnessCommandTypingResult =
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_NOT_CLAUDE }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.FAILED; reason: string };

const APPLIED: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED,
};
const SKIPPED_BUSY: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY,
};
const SKIPPED_NOT_CLAUDE: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_NOT_CLAUDE,
};
const PANE_CLOSED: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED,
};

function failed(reason: string): HarnessCommandTypingResult {
  return { outcome: HARNESS_COMMAND_TYPING_OUTCOMES.FAILED, reason };
}

const NO_SENDER_NAME = "";
const DIALOG_CLOSING_KEY = "Escape";

const RAW_COMMAND_INTO_AN_EMPTY_TEXTBOX_ONLY: SubmitToAgentOptions = {
  omitSenderAttribution: true,
  composerWaitMilliseconds: 0,
  leaveResidentDraftUnsubmitted: true,
};

export function isPaneSafeToTypeACommandInto(
  agentStatus: AgentStatus,
  screen: SupportedAgentScreenSnapshot,
): boolean {
  return (
    agentStatusAcceptsInput(agentStatus) &&
    screen.activeComposer.state === "empty"
  );
}

export async function typeHarnessCommandIntoIdleClaudePane(
  agent: HerdrAgent,
  commandText: string,
  deps: SubmitToAgentDeps = defaultSubmitToAgentDeps(agent),
): Promise<HarnessCommandTypingResult> {
  if (agent.agent !== HARNESS_NAMES.CLAUDE) return SKIPPED_NOT_CLAUDE;
  try {
    return await deps.withRecipientPaneLock(agent.paneId, () =>
      typeHarnessCommandWhileHoldingThePaneLock(agent, commandText, deps),
    );
  } catch {
    return SKIPPED_BUSY;
  }
}

async function typeHarnessCommandWhileHoldingThePaneLock(
  agent: HerdrAgent,
  commandText: string,
  deps: SubmitToAgentDeps,
): Promise<HarnessCommandTypingResult> {
  const liveAgent = await liveAgentSafeToTypeACommandInto(agent, deps);
  if (liveAgent === undefined) return SKIPPED_BUSY;
  try {
    await submitToAgentWhileLocked(
      liveAgent,
      NO_SENDER_NAME,
      commandText,
      RAW_COMMAND_INTO_AN_EMPTY_TEXTBOX_ONLY,
      deps,
    );
    return APPLIED;
  } catch (error) {
    if (error instanceof SubmitNotSentError) return SKIPPED_BUSY;
    if (isHerdrPaneGone(error)) return PANE_CLOSED;
    return failedAfterClosingALeftoverDialog(liveAgent, errorText(error), deps);
  }
}

async function liveAgentSafeToTypeACommandInto(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<HerdrAgent | undefined> {
  try {
    const liveAgent = await deps.refreshRecipientIdentity(
      recipientName(agent),
      agent,
    );
    if (!sameRecipientPaneIdentity(agent, liveAgent)) return undefined;
    const screen = await observeSupportedScreen(
      liveAgent,
      HARNESS_NAMES.CLAUDE,
      deps,
    );
    return isPaneSafeToTypeACommandInto(liveAgent.agentStatus, screen)
      ? liveAgent
      : undefined;
  } catch {
    return undefined;
  }
}

async function failedAfterClosingALeftoverDialog(
  agent: HerdrAgent,
  submitFailure: string,
  deps: SubmitToAgentDeps,
): Promise<HarnessCommandTypingResult> {
  if (!(await commandLeftADialogOpen(agent, deps))) return failed(submitFailure);
  try {
    await deps.pressPaneKey(agent.paneId, DIALOG_CLOSING_KEY);
  } catch (error) {
    return failed(
      `the command left a dialog open and the ${DIALOG_CLOSING_KEY} that ` +
        `closes it failed: ${errorText(error)}`,
    );
  }
  return failed(
    `the command left a dialog open, closed with one ${DIALOG_CLOSING_KEY}: ` +
      submitFailure,
  );
}

async function commandLeftADialogOpen(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<boolean> {
  try {
    const screen = await observeSupportedScreen(
      agent,
      HARNESS_NAMES.CLAUDE,
      deps,
    );
    return screen.activeComposer.state === "modal";
  } catch {
    return false;
  }
}
