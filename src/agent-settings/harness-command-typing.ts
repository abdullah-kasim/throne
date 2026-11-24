import type { SupportedAgentScreenSnapshot, SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { claudeModFallbackLine } from "../herdr/claude-mod-route.ts";
import { agentAlive, deliverThroughExtension } from "../herdr/delivery-request-client.ts";
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
import type { SubmitToAgentDeps, SubmitToAgentOptions } from "../herdr/herdr-send.types.ts";
import { errorText } from "../shared-policy/error-text.ts";

export const HARNESS_COMMAND_TYPING_OUTCOMES = {
  APPLIED: "applied",
  SKIPPED_BUSY: "skipped-busy",
  SKIPPED_NOT_CLAUDE: "skipped-not-claude",
  SKIPPED_PI_EXTENSION_TAKES_NO_COMMANDS: "skipped-pi-extension-takes-no-commands",
  PANE_CLOSED: "pane-closed",
  FAILED: "failed",
} as const;

export type HarnessCommandTypingResult =
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.APPLIED }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_BUSY }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_NOT_CLAUDE }
  | { outcome: typeof HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_PI_EXTENSION_TAKES_NO_COMMANDS }
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
const SKIPPED_PI_EXTENSION_TAKES_NO_COMMANDS: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.SKIPPED_PI_EXTENSION_TAKES_NO_COMMANDS,
};
const PANE_CLOSED: HarnessCommandTypingResult = {
  outcome: HARNESS_COMMAND_TYPING_OUTCOMES.PANE_CLOSED,
};

function failed(reason: string): HarnessCommandTypingResult {
  return { outcome: HARNESS_COMMAND_TYPING_OUTCOMES.FAILED, reason };
}

export const HARNESS_COMMAND_WAIT_MILLISECONDS = 2_000;

const NO_SENDER_NAME = "";
const DIALOG_CLOSING_KEY = "Escape";

const RAW_COMMAND_INTO_AN_EMPTY_TEXTBOX_ONLY: SubmitToAgentOptions = {
  omitSenderAttribution: true,
  composerWaitMilliseconds: 0,
  leaveResidentDraftUnsubmitted: true,
};

const TYPED_NOT_SENT_THROUGH_THE_EXTENSION = async () =>
  ({ kind: "not-answering", detail: "the pi extension takes no commands, so the command is typed" }) as const;

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
  return typeHarnessCommandUnderThePaneLock(agent, commandText, deps, HARNESS_NAMES.CLAUDE);
}

async function typeHarnessCommandUnderThePaneLock(
  agent: HerdrAgent,
  commandText: string,
  deps: SubmitToAgentDeps,
  harness: SupportedComposerHarness,
): Promise<HarnessCommandTypingResult> {
  try {
    return await deps.withRecipientPaneLock(agent.paneId, () =>
      typeHarnessCommandWhileHoldingThePaneLock(agent, commandText, deps, harness),
    );
  } catch {
    return SKIPPED_BUSY;
  }
}

export async function claudeModTakesCommandsOf(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
): Promise<boolean> {
  const claudeMod = deps.claudeMod;
  if (claudeMod === undefined || !(await claudeMod.usesMod(recipientName(agent)))) return false;
  const alive = await claudeMod.alive(await claudeMod.socketOf(recipientName(agent)), agent.paneId);
  return alive?.commands === true;
}

function commandRequestOf(commandText: string): { command: string; args: string } {
  const [command = "", ...words] = commandText.replace(/^\//u, "").split(" ");
  return { command, args: words.join(" ") };
}

export async function sendHarnessCommandToThePiExtension(
  agent: HerdrAgent,
  commandText: string,
  socketPath?: string,
  deps: SubmitToAgentDeps = defaultSubmitToAgentDeps(agent),
): Promise<HarnessCommandTypingResult> {
  const deliverySocket =
    socketPath ?? (await readSpawnSpec(recipientName(agent)))?.delivery_socket;
  if ((await agentAlive(deliverySocket, agent.paneId))?.commands !== true) {
    return typeHarnessCommandUnderThePaneLock(
      agent,
      commandText,
      { ...deps, claudeMod: undefined, deliverToPi: TYPED_NOT_SENT_THROUGH_THE_EXTENSION },
      HARNESS_NAMES.PI,
    );
  }
  const outcome = await deliverThroughExtension(
    commandRequestOf(commandText),
    HARNESS_COMMAND_WAIT_MILLISECONDS,
    agent.paneId,
    { socketPath: deliverySocket },
  );
  if (outcome.kind === "delivered" || outcome.kind === "accepted") return APPLIED;
  if (outcome.kind === "refused") return failed(outcome.detail);
  if (outcome.kind === "timed-out") return SKIPPED_BUSY;
  return SKIPPED_PI_EXTENSION_TAKES_NO_COMMANDS;
}

async function runCommandThroughTheClaudeMod(
  agent: HerdrAgent,
  commandText: string,
  deps: SubmitToAgentDeps,
): Promise<HarnessCommandTypingResult | undefined> {
  const claudeMod = deps.claudeMod;
  if (claudeMod === undefined || !(await claudeModTakesCommandsOf(agent, deps))) return undefined;
  const socketPath = await claudeMod.socketOf(recipientName(agent));
  const outcome = await deps.deliverThroughExtension(
    commandRequestOf(commandText),
    HARNESS_COMMAND_WAIT_MILLISECONDS,
    agent.paneId,
    socketPath === undefined ? {} : { socketPath },
  );
  if (outcome.kind === "delivered" || outcome.kind === "accepted") return APPLIED;
  if (outcome.kind === "timed-out" && (await claudeMod.alive(socketPath, agent.paneId)) !== undefined) return SKIPPED_BUSY;
  claudeMod.log(
    claudeModFallbackLine(
      recipientName(agent),
      outcome.kind === "timed-out" ? `no answer after ${outcome.waitedMs}ms; the connection was closed` : outcome.detail,
    ),
  );
  return undefined;
}

async function typeHarnessCommandWhileHoldingThePaneLock(
  agent: HerdrAgent,
  commandText: string,
  deps: SubmitToAgentDeps,
  harness: SupportedComposerHarness,
): Promise<HarnessCommandTypingResult> {
  const throughTheMod = await runCommandThroughTheClaudeMod(agent, commandText, deps);
  if (throughTheMod !== undefined) return throughTheMod;
  const liveAgent = await liveAgentSafeToTypeACommandInto(agent, deps, harness);
  if (liveAgent === undefined) return SKIPPED_BUSY;
  try {
    await submitToAgentWhileLocked(
      liveAgent,
      NO_SENDER_NAME,
      commandText,
      RAW_COMMAND_INTO_AN_EMPTY_TEXTBOX_ONLY,
      { ...deps, claudeMod: undefined },
    );
    return APPLIED;
  } catch (error) {
    if (error instanceof SubmitNotSentError) return SKIPPED_BUSY;
    if (isHerdrPaneGone(error)) return PANE_CLOSED;
    return failedAfterClosingALeftoverDialog(liveAgent, errorText(error), deps, harness);
  }
}

async function liveAgentSafeToTypeACommandInto(
  agent: HerdrAgent,
  deps: SubmitToAgentDeps,
  harness: SupportedComposerHarness,
): Promise<HerdrAgent | undefined> {
  try {
    const liveAgent = await deps.refreshRecipientIdentity(
      recipientName(agent),
      agent,
    );
    if (!sameRecipientPaneIdentity(agent, liveAgent)) return undefined;
    const screen = await observeSupportedScreen(liveAgent, harness, deps);
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
  harness: SupportedComposerHarness,
): Promise<HarnessCommandTypingResult> {
  if (!(await commandLeftADialogOpen(agent, deps, harness))) return failed(submitFailure);
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
  harness: SupportedComposerHarness,
): Promise<boolean> {
  try {
    const screen = await observeSupportedScreen(agent, harness, deps);
    return screen.activeComposer.state === "modal";
  } catch {
    return false;
  }
}
