import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import {
  parseSendAgentLegacyInput,
  sendAgentLegacyInputError,
  type SendAgentLegacyInput,
} from "./send-agent-legacy-input.ts";
import {
  productionAlphaMonitoringDependencies,
  recordDeliveredSupervisionEvent,
} from "../alpha-monitoring/alpha-monitoring.ts";
import {
  IdentityDataService,
  identityFieldForRecording,
} from "../agentdata/identity-data.service.ts";
import { clearBlockedMarker } from "../agentdata/blocked-marker.service.ts";
import { resolveAgent } from "../herdr/herdr-runtime.service.ts";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { submitToAgent } from "../herdr/herdr-send.service.ts";
import {
  COMPOSER_RECOGNITION_TIMEOUT_MS,
  SubmitAssumedFilledError,
  SubmitNotSentError,
} from "../herdr/herdr-send.types.ts";

/**
 * DWR (Regent ruling, 2026-08-14, verbatim: "a rescue tool that waits 15
 * minutes is not a rescue tool"): this rescue path exists for when the
 * queue/backend is itself broken, so it deliberately opts OUT of the
 * court-wide 15-minute resident-draft wait-and-force behaviour
 * (`RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS`) that every other sender now
 * inherits from `submitToAgent`. An operator reaching for send-agent-legacy
 * wants an immediate, honest "the recipient's box is occupied" — not the
 * rescue tool silently submitting someone else's draft while it jams an
 * emergency message through. Bounded to the same tight recognition window
 * `resolveComposerWaitDeadline` already uses to distinguish "genuinely
 * busy" from "idle/unrecognized", so a truly empty composer still delivers
 * near-instantly.
 */
const SEND_AGENT_LEGACY_COMPOSER_WAIT_MS = COMPOSER_RECOGNITION_TIMEOUT_MS;

/** Distinguishable exit codes for send-agent-legacy's pane-write verdicts; `delivered` keeps the existing 0. */
const SEND_AGENT_LEGACY_EXIT_CODE = {
  notSent: 1,
  assumedFilled: 2,
} as const;

export interface SendAgentLegacyCommandDependencies<
  Recipient extends { name?: string; paneId?: string } = { name?: string; paneId?: string },
> {
  resolveAgent(name: string): Promise<Recipient>;
  resolveCurrentAgentName(): Promise<string>;
  submitToAgent(
    recipient: Recipient,
    senderName: string,
    prompt: string,
    options: {
      key?: string;
      onDeliveredWhileLocked?: () => Promise<void>;
      composerWaitMilliseconds?: number;
      forceSubmitResidentDraftOnTimeout?: boolean;
    },
  ): Promise<void>;
  readAgentRole?: IdentityDataService['readAgentRole'];
  readAgentSupervisor?: IdentityDataService['readAgentSupervisor'];
  recordDeliveredEvent?: typeof recordDeliveredSupervisionEvent;
  clearBlockedMarker?: typeof clearBlockedMarker;
}

let productionDependencies: SendAgentLegacyCommandDependencies | undefined;

const DEFAULT_PRODUCTION_DEPENDENCIES: SendAgentLegacyCommandDependencies = {
  resolveAgent,
  resolveCurrentAgentName,
  submitToAgent,
  clearBlockedMarker,
};

export function configureSendAgentLegacyCommandDependencies(
  dependencies: SendAgentLegacyCommandDependencies,
): void {
  productionDependencies = dependencies;
}

@Command({
  name: "send-agent-legacy",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SendAgentLegacyCommand extends CommandRunner {
  private readonly dependencies?: SendAgentLegacyCommandDependencies;

  constructor(dependencies?: SendAgentLegacyCommandDependencies) {
    super();
    this.dependencies = dependencies;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    let parsed: SendAgentLegacyInput;
    try {
      parsed = parseSendAgentLegacyInput(passedParams);
    } catch (error) {
      process.stderr.write(sendAgentLegacyInputError(error));
      process.exitCode = 1;
      return;
    }

    const dependencies =
      this.dependencies ?? productionDependencies ?? DEFAULT_PRODUCTION_DEPENDENCIES;

    await runSendAgentLegacy(parsed, dependencies);
  }
}

/**
 * The pre-conversion synchronous pane-write path, preserved verbatim as an
 * independent fallback: resolve recipient and sender, deliver through
 * `submitToAgent`, and map its typed outcome to a typed not-sent/
 * assumed-filled exit code — no queue, no store, no heartbeat involved.
 */
async function runSendAgentLegacy(
  parsed: SendAgentLegacyInput,
  dependencies: SendAgentLegacyCommandDependencies,
): Promise<void> {
  const recipient = await dependencies.resolveAgent(parsed.recipientName);
  let actualSenderName = parsed.senderName === undefined
    ? await dependencies.resolveCurrentAgentName()
    : undefined;
  const senderName = parsed.senderName ?? actualSenderName!;
  const canRecordEvent =
    dependencies.readAgentRole !== undefined &&
    dependencies.readAgentSupervisor !== undefined &&
    dependencies.recordDeliveredEvent !== undefined;
  const onDeliveredWhileLocked = canRecordEvent ? async () => {
    if (actualSenderName === undefined) {
      try {
        actualSenderName = await dependencies.resolveCurrentAgentName();
      } catch {
        return;
      }
    }
    try {
      const recipientName = recipient.name ?? parsed.recipientName;
      await dependencies.recordDeliveredEvent!(
        {
          sender: actualSenderName,
          senderRole: identityFieldForRecording(
            await dependencies.readAgentRole!(actualSenderName),
          ),
          senderSupervisor: identityFieldForRecording(
            await dependencies.readAgentSupervisor!(actualSenderName),
          ),
          recipient: recipientName,
          recipientRole: identityFieldForRecording(
            await dependencies.readAgentRole!(recipientName),
          ),
          prompt: parsed.prompt,
        },
        productionAlphaMonitoringDependencies(async () => null),
      );
    } catch (error) {
      process.stderr.write(`send-agent-legacy: delivered, but supervision event recording failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  } : undefined;
  try {
    await dependencies.submitToAgent(recipient, senderName, parsed.prompt, {
      ...(parsed.key === undefined ? {} : { key: parsed.key }),
      ...(onDeliveredWhileLocked === undefined ? {} : { onDeliveredWhileLocked }),
      composerWaitMilliseconds: SEND_AGENT_LEGACY_COMPOSER_WAIT_MS,
      forceSubmitResidentDraftOnTimeout: false,
    });
  } catch (error) {
    if (error instanceof SubmitNotSentError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = SEND_AGENT_LEGACY_EXIT_CODE.notSent;
      return;
    }
    if (error instanceof SubmitAssumedFilledError) {
      // A composer has exactly two states: empty or filled. A third verdict
      // for "we couldn't tell" would encode our own uncertainty about the
      // observation as if it were the composer's own state — so this
      // command never surfaces one. `SubmitAssumedFilledError` already means
      // herdr looked, couldn't tell, ran out of looks, and assumed filled;
      // this branch reports that assumed-filled verdict, it does not invent
      // a third exit code for it.
      process.stderr.write(`${error.message}\n`);
      process.exitCode = SEND_AGENT_LEGACY_EXIT_CODE.assumedFilled;
      return;
    }
    throw error;
  }
  await dependencies.clearBlockedMarker?.(senderName);
  if (parsed.clearBlocked) {
    await dependencies.clearBlockedMarker?.(recipient.name ?? parsed.recipientName);
  }
  process.exitCode = 0;
}
