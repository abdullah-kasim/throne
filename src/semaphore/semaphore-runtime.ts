import { setTimeout as waitFor } from "node:timers/promises";
import { handOverLock, releaseLock } from "../shared-policy/lock-rows/lock-rows.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import {
  parseSemaphoreArguments,
  SEMAPHORE_USAGE,
  SemaphoreAction,
  type SemaphoreArguments,
} from "./semaphore-arguments.ts";
import { runCommandHoldingSlot, type CommandToRun } from "./semaphore-run.ts";
import { readSemaphoreStatuses, renderSemaphoreStatuses, renderSemaphoreStatusesAsJson } from "./semaphore-status.ts";
import { readSlotCount, recordSlotHolder, takeFirstFreeSlot, writeSlotCount, type TakenSlot } from "./semaphore-store.ts";

export const SemaphoreExitCode = {
  Done: 0,
  Missing: 1,
  InvalidInvocation: 2,
} as const;

const MESSAGE_PREFIX = "throne semaphore:";
const RETRY_MILLISECONDS = 1000;

export interface SemaphoreDependencies {
  readonly throneHome: string;
  readonly retryMilliseconds: number;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

type CreateArguments = Extract<SemaphoreArguments, { action: typeof SemaphoreAction.Create }>;
type RunArguments = Extract<SemaphoreArguments, { action: typeof SemaphoreAction.Run }>;
type StatusArguments = Extract<SemaphoreArguments, { action: typeof SemaphoreAction.Status }>;

export function realSemaphoreDependencies(environment: NodeJS.ProcessEnv = process.env): SemaphoreDependencies {
  return {
    throneHome: resolveThroneHome(environment),
    retryMilliseconds: RETRY_MILLISECONDS,
    out: (message) => void process.stdout.write(message),
    err: (message) => void process.stderr.write(message),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createCommandFor(name: string): string {
  return `throne semaphore create ${name} --slots <n>`;
}

function commandLineOf(toRun: CommandToRun): string {
  return [toRun.command, ...toRun.commandArguments].join(" ");
}

async function createSemaphore(parsed: CreateArguments, dependencies: SemaphoreDependencies): Promise<number> {
  await writeSlotCount(dependencies.throneHome, parsed.name, parsed.slots);
  dependencies.out(`semaphore "${parsed.name}" has ${parsed.slots} slots\n`);
  return SemaphoreExitCode.Done;
}

async function waitForFreeSlot(name: string, dependencies: SemaphoreDependencies): Promise<TakenSlot | undefined> {
  let toldThatItWaits = false;
  for (;;) {
    const slots = await readSlotCount(dependencies.throneHome, name);
    if (slots === undefined) return undefined;
    const taken = takeFirstFreeSlot(dependencies.throneHome, name, slots);
    if (taken !== undefined) return taken;
    if (!toldThatItWaits) {
      dependencies.err(`${MESSAGE_PREFIX} waiting for a free slot of "${name}" (${slots} slots, all held)\n`);
      toldThatItWaits = true;
    }
    await waitFor(dependencies.retryMilliseconds);
  }
}

async function runInFreeSlot(parsed: RunArguments, dependencies: SemaphoreDependencies): Promise<number> {
  const taken = await waitForFreeSlot(parsed.name, dependencies);
  if (taken === undefined) {
    dependencies.err(
      `${MESSAGE_PREFIX} there is no semaphore "${parsed.name}"; create it first: ${createCommandFor(parsed.name)}\n`,
    );
    return SemaphoreExitCode.InvalidInvocation;
  }
  let commandProcessId: number | undefined;
  try {
    return await runCommandHoldingSlot(parsed, {
      started: async (pid) => {
        commandProcessId = pid;
        try {
          recordSlotHolder(taken, pid, commandLineOf(parsed));
        } catch (error) {
          dependencies.err(`${MESSAGE_PREFIX} the slot is held but its holder could not be recorded: ${messageOf(error)}\n`);
        }
      },
      couldNotStart: (error) => dependencies.err(`${MESSAGE_PREFIX} could not start "${parsed.command}": ${messageOf(error)}\n`),
    });
  } finally {
    if (commandProcessId === undefined) releaseLock(taken.lock);
    else handOverLock(taken.lock, commandProcessId);
  }
}

async function showStatus(parsed: StatusArguments, dependencies: SemaphoreDependencies): Promise<number> {
  const statuses = await readSemaphoreStatuses(dependencies.throneHome, parsed.name);
  dependencies.out(parsed.json ? renderSemaphoreStatusesAsJson(statuses) : renderSemaphoreStatuses(statuses));
  if (parsed.name !== undefined && statuses.length === 0) {
    dependencies.err(`${MESSAGE_PREFIX} there is no semaphore "${parsed.name}"\n`);
    return SemaphoreExitCode.Missing;
  }
  return SemaphoreExitCode.Done;
}

export async function runSemaphore(
  commandArguments: readonly string[],
  dependencies: SemaphoreDependencies = realSemaphoreDependencies(),
): Promise<number> {
  let parsed: SemaphoreArguments;
  try {
    parsed = parseSemaphoreArguments(commandArguments);
  } catch (error) {
    dependencies.err(`${MESSAGE_PREFIX} ${messageOf(error)}\n${SEMAPHORE_USAGE}\n`);
    return SemaphoreExitCode.InvalidInvocation;
  }
  if (parsed.action === SemaphoreAction.Help) {
    dependencies.out(`${SEMAPHORE_USAGE}\n`);
    return SemaphoreExitCode.Done;
  }
  if (parsed.action === SemaphoreAction.Create) return createSemaphore(parsed, dependencies);
  if (parsed.action === SemaphoreAction.Run) return runInFreeSlot(parsed, dependencies);
  return showStatus(parsed, dependencies);
}
