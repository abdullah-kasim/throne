import path from "node:path";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { resolveSpecLocation } from "../spec-location/spec-location.ts";
import { DEFAULT_LOCK_DURATION, FolderLockOutcome, lockMillisecondsOf, takeFolderLock } from "./folder-lock.ts";

const DONE = 0;
const HELD_BY_ANOTHER = 1;
const REFUSED = 2;
const SPEC_LOCK_FILE_NAME = "spec.edit.lock";
const SPEC_LOCK_NAME = "external spec edit";
const UNNAMED_WRITER = "an unnamed writer";

export const SPEC_LOCK_USAGE =
  `Usage: throne spec-lock --repository <path> [--ttl <seconds>s|<minutes>m, default ${DEFAULT_LOCK_DURATION}, at most 15m]\n` +
  "Holds the edit lock on the repository's spec folder under the throne data home until this process is stopped (TERM or INT) or the ttl ends.\n" +
  "Edit the external spec and feature map only while it prints \"locked by\"; a second writer is refused with the holder's name and exit 1.\n";

export interface SpecLockDependencies {
  readonly environment: NodeJS.ProcessEnv;
  readonly processId: number;
  readonly now: () => Date;
  currentAgentName(): Promise<string>;
  waitForRelease(holdForMilliseconds: number): Promise<void>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

interface SpecLockRequest {
  readonly repository: string;
  readonly holdForMilliseconds: number;
}

function parseSpecLockRequest(commandArguments: readonly string[]): SpecLockRequest {
  let repository: string | undefined;
  let ttl = DEFAULT_LOCK_DURATION;
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    const value = commandArguments[index + 1];
    if (argument !== "--repository" && argument !== "--ttl") throw new Error(`unexpected argument "${argument}"`);
    if (value === undefined) throw new Error(`${argument} needs a value`);
    if (argument === "--repository") repository = value;
    else ttl = value;
    index += 1;
  }
  if (repository === undefined) throw new Error("name the repository with --repository");
  return { repository: path.resolve(repository), holdForMilliseconds: lockMillisecondsOf(ttl) };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writerNameOf(dependencies: SpecLockDependencies): Promise<string> {
  const name = await dependencies.currentAgentName().catch(() => UNNAMED_WRITER);
  return `${name} (process ${dependencies.processId})`;
}

export async function runSpecLock(commandArguments: readonly string[], dependencies: SpecLockDependencies): Promise<number> {
  let request: SpecLockRequest;
  try {
    request = parseSpecLockRequest(commandArguments);
  } catch (error) {
    dependencies.writeStderr(`${SPEC_LOCK_USAGE}spec-lock refused: ${messageOf(error)}\n`);
    return REFUSED;
  }
  const dataHome = resolveThroneHome(dependencies.environment);
  let specFolder: string;
  try {
    specFolder = path.dirname((await resolveSpecLocation(request.repository, dataHome)).settingsFile);
  } catch (error) {
    dependencies.writeStderr(`spec-lock refused: ${messageOf(error)}\n`);
    return REFUSED;
  }
  const until = new Date(dependencies.now().getTime() + request.holdForMilliseconds);
  const attempt = await takeFolderLock(
    path.join(specFolder, SPEC_LOCK_FILE_NAME),
    SPEC_LOCK_NAME,
    await writerNameOf(dependencies),
    until,
  );
  if (attempt.outcome === FolderLockOutcome.HeldByAnother) {
    dependencies.writeStderr(`spec-lock: ${specFolder} is locked by ${attempt.holder}; nothing was taken. Wait for it to be released, then try again.\n`);
    return HELD_BY_ANOTHER;
  }
  try {
    dependencies.writeStdout(`spec-lock: locked by ${attempt.holder}. folder: ${specFolder}\n`);
    await dependencies.waitForRelease(request.holdForMilliseconds);
  } finally {
    await attempt.lock.release();
  }
  dependencies.writeStdout(`spec-lock: released ${specFolder}\n`);
  return DONE;
}
