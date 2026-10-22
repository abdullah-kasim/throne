import { execFile } from "node:child_process";
import { text as readStreamAsText } from "node:stream/consumers";
import { promisify } from "node:util";
import { resolveCurrentAgentName } from "../herdr/herdr-session.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { CANONICAL_REGENT_AUTHORITY } from "../shared-policy/regent-authority.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import {
  addEventUnlessAnEditIsHeld,
  EditLockOutcome,
  journalUnrecordedEditUnlessAnEditIsHeld,
  releaseEditLock,
  takeEditLock,
} from "./edit-lock.ts";
import { isTheLordsName } from "./page-journal.ts";
import { saveOneUnitAsTheLord, SaveOutcome, unitChangeOf, type SaveAttempt } from "./page-save.ts";
import { pagePathIn, PageWriteOutcome, showPage, type PageWriter } from "./page-store.ts";
import type { UnrecordedEdit } from "./unrecorded-edit.ts";
import {
  parseWhereIStandArguments,
  WHERE_I_STAND_USAGE,
  WhereIStandAction,
  type WhereIStandArguments,
} from "./where-i-stand-arguments.ts";
import {
  NOTHING_WAS_WRITTEN,
  renderBrokenFrameOnNote,
  renderFaultsAtRelease,
  renderHeldByAnother,
  renderLockHeld,
  renderNameReservedForTheLord,
  renderRelease,
  renderSaveAnswer,
  renderStaleChecksum,
  renderUnrecordedEdit,
  renderWriteIsGone,
  SAVE_INPUT_REFUSED,
} from "./where-i-stand-messages.ts";

export const WhereIStandExitCode = {
  Done: 0,
  Refused: 1,
  InvalidInvocation: 2,
  ReleasedWithFaults: 3,
} as const;

export interface WhereIStandDependencies {
  readonly dataHome: string;
  readonly currentAgentName: () => Promise<string>;
  readonly now: () => Date;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
  readonly waitForRelease: (holdForMilliseconds: number) => Promise<void>;
  readonly tellRegent: (message: string) => Promise<void>;
  readonly readStandardInput: () => Promise<string>;
  readonly flockExecutable?: string;
}

const execFileAsync = promisify(execFile);
const RELEASE_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export function waitForStopOrTimeout(holdForMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, holdForMilliseconds);
    for (const signal of RELEASE_SIGNALS) {
      process.on(signal, () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

export function realWhereIStandDependencies(
  environment: NodeJS.ProcessEnv = process.env,
): WhereIStandDependencies {
  return {
    dataHome: resolveThroneHome(environment),
    currentAgentName: resolveCurrentAgentName,
    now: () => new Date(),
    out: (message) => void process.stdout.write(message),
    err: (message) => void process.stderr.write(message),
    waitForRelease: waitForStopOrTimeout,
    tellRegent: async (message) => {
      await execFileAsync("throne", ["send-agent", CANONICAL_REGENT_AUTHORITY, message]);
    },
    readStandardInput: () => readStreamAsText(process.stdin),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderInvalidInvocation(error: unknown): string {
  return `${messageOf(error)}\n${WHERE_I_STAND_USAGE}\n${renderEntranceRefusal({
    reason: "where-i-stand entrance validation refused this invocation; the page was not touched.",
    bypass: undefined,
    supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
  })}\n`;
}

function renderCallerWithoutIdentity(error: unknown): string {
  return `${NOTHING_WAS_WRITTEN} ${renderEntranceRefusal({
    reason: `Only a caller with an agent identity may lock or write the page, and this caller has none (${messageOf(error)}).`,
    bypass: undefined,
    supervisorRoute: "Run the command from your own agent pane, or ask your supervisor to make the edit.",
  })}\n`;
}

async function tellRegentOrSayWhyNot(message: string, dependencies: WhereIStandDependencies): Promise<void> {
  try {
    await dependencies.tellRegent(message);
  } catch (error) {
    dependencies.err(`where-i-stand: the Regent could not be told (${messageOf(error)}): ${message}`);
  }
}

async function reportUnrecordedEdit(
  unrecordedEdit: UnrecordedEdit | undefined,
  dependencies: WhereIStandDependencies,
): Promise<void> {
  if (unrecordedEdit === undefined) return;
  const report = renderUnrecordedEdit(unrecordedEdit, pagePathIn(dependencies.dataHome));
  dependencies.err(report);
  await tellRegentOrSayWhyNot(report, dependencies);
}

async function showThePage(dependencies: WhereIStandDependencies): Promise<number> {
  await reportUnrecordedEdit(await journalUnrecordedEditUnlessAnEditIsHeld(dependencies), dependencies);
  const page = await showPage(dependencies.dataHome);
  dependencies.out(page.content);
  dependencies.err(`path: ${pagePathIn(dependencies.dataHome)}\nchecksum: ${page.version}\n`);
  return WhereIStandExitCode.Done;
}

async function addNote(writer: PageWriter, event: string, dependencies: WhereIStandDependencies): Promise<number> {
  const attempt = await addEventUnlessAnEditIsHeld(writer, event);
  if (attempt.outcome === EditLockOutcome.HeldByAnother) {
    dependencies.err(renderHeldByAnother(attempt.holder));
    return WhereIStandExitCode.Refused;
  }
  await reportUnrecordedEdit(attempt.unrecordedEdit, dependencies);
  if (attempt.written.outcome === PageWriteOutcome.FrameBroken) {
    dependencies.err(renderBrokenFrameOnNote(attempt.written.faults, attempt.unrecordedEdit !== undefined));
    return WhereIStandExitCode.Refused;
  }
  dependencies.out(`where-i-stand: written. checksum: ${attempt.written.version}\n`);
  return WhereIStandExitCode.Done;
}

async function holdTheEditLock(
  writer: PageWriter,
  parsed: Extract<WhereIStandArguments, { action: typeof WhereIStandAction.Lock }>,
  dependencies: WhereIStandDependencies,
): Promise<number> {
  const until = new Date(dependencies.now().getTime() + parsed.holdForMilliseconds);
  const attempt = await takeEditLock(writer, parsed.checksum, until);
  if (attempt.outcome === EditLockOutcome.HeldByAnother) {
    dependencies.err(renderHeldByAnother(attempt.holder));
    return WhereIStandExitCode.Refused;
  }
  await reportUnrecordedEdit(attempt.unrecordedEdit, dependencies);
  if (attempt.outcome === EditLockOutcome.StaleChecksum) {
    dependencies.err(renderStaleChecksum(attempt.currentChecksum, attempt.unrecordedEdit !== undefined));
    return WhereIStandExitCode.Refused;
  }
  dependencies.out(renderLockHeld(attempt.holder, pagePathIn(dependencies.dataHome)));
  await dependencies.waitForRelease(parsed.holdForMilliseconds);
  const released = await releaseEditLock(writer, attempt);
  dependencies.out(renderRelease(released));
  const faults = renderFaultsAtRelease(released);
  if (faults === "") return WhereIStandExitCode.Done;
  dependencies.err(faults);
  await tellRegentOrSayWhyNot(`${writer.name} released the page's edit lock with faults to fix. ${faults}`, dependencies);
  return WhereIStandExitCode.ReleasedWithFaults;
}

async function changeThePage(
  parsed: Extract<WhereIStandArguments, { action: typeof WhereIStandAction.Lock | typeof WhereIStandAction.Note }>,
  dependencies: WhereIStandDependencies,
): Promise<number> {
  let writerName: string;
  try {
    writerName = await dependencies.currentAgentName();
  } catch (error) {
    dependencies.err(renderCallerWithoutIdentity(error));
    return WhereIStandExitCode.Refused;
  }
  if (isTheLordsName(writerName)) {
    dependencies.err(renderNameReservedForTheLord(writerName));
    return WhereIStandExitCode.Refused;
  }
  const writer: PageWriter = {
    dataHome: dependencies.dataHome,
    name: writerName,
    now: dependencies.now,
    flockExecutable: dependencies.flockExecutable,
  };
  try {
    return parsed.action === WhereIStandAction.Note
      ? await addNote(writer, parsed.event, dependencies)
      : await holdTheEditLock(writer, parsed, dependencies);
  } catch (error) {
    dependencies.err(`${NOTHING_WAS_WRITTEN} ${messageOf(error)}\n`);
    return WhereIStandExitCode.Refused;
  }
}

function printSaveAnswer(outcome: SaveAttempt["outcome"], message: string, dependencies: WhereIStandDependencies): void {
  dependencies.out(`${JSON.stringify({ outcome, message })}\n`);
}

function isAKeptSave(attempt: SaveAttempt): boolean {
  return attempt.outcome === SaveOutcome.Saved || attempt.outcome === SaveOutcome.Unchanged;
}

async function saveFromThePage(dependencies: WhereIStandDependencies): Promise<number> {
  const change = unitChangeOf(await dependencies.readStandardInput());
  if (change === undefined) {
    printSaveAnswer(SaveOutcome.Failed, SAVE_INPUT_REFUSED, dependencies);
    return WhereIStandExitCode.InvalidInvocation;
  }
  let attempt: SaveAttempt;
  try {
    attempt = await saveOneUnitAsTheLord(dependencies, change);
  } catch (error) {
    attempt = { outcome: SaveOutcome.Failed, reason: messageOf(error) };
  }
  await reportUnrecordedEdit(attempt.unrecordedEdit, dependencies);
  printSaveAnswer(attempt.outcome, renderSaveAnswer(attempt), dependencies);
  return isAKeptSave(attempt) ? WhereIStandExitCode.Done : WhereIStandExitCode.Refused;
}

export async function runWhereIStand(
  commandArguments: readonly string[],
  dependencies: WhereIStandDependencies = realWhereIStandDependencies(),
): Promise<number> {
  let parsed: WhereIStandArguments;
  try {
    parsed = parseWhereIStandArguments(commandArguments);
  } catch (error) {
    dependencies.err(renderInvalidInvocation(error));
    return WhereIStandExitCode.InvalidInvocation;
  }
  if (parsed.action === WhereIStandAction.Write) {
    dependencies.err(renderWriteIsGone());
    return WhereIStandExitCode.Refused;
  }
  if (parsed.action === WhereIStandAction.Show) return showThePage(dependencies);
  if (parsed.action === WhereIStandAction.Save) return saveFromThePage(dependencies);
  return changeThePage(parsed, dependencies);
}
