import { readFile } from "node:fs/promises";
import { readGitStatus, runGit } from "../git-lifecycle/git-command.service.ts";
import { renderEntranceRefusal } from "../shared-policy/entrance-refusal.ts";
import { RUNTIME_DATA_HOME } from "../shared-policy/runtime-data-home.ts";
import { resolveCourtCheckout, type CourtCheckout } from "./court-checkout.ts";
import { formatFileLine } from "./file-line.ts";
import { pairEntriesWithFindings, PushWaiverReason, readEntries, type WaivedFinding, type WaiverEntry } from "./push-waiver-entries.ts";
import { checkEntryEvidence } from "./push-waiver-evidence.ts";
import { readFindings } from "./push-waiver-findings.ts";
import { writeWaiverRecord, type WaiverRecord } from "./push-waiver-record.ts";
import { PushWaiverRefusal } from "./push-waiver-refusal.ts";

export const PushWaiverExitCode = {
  Written: 0,
  InvalidInvocation: 1,
  Refused: 66,
} as const;

export const PUSH_WAIVER_USAGE =
  "usage: throne push-waiver --repo <dir> --remote <name> --ref <local branch> --findings-file <file> --entries-file <file>";

const PUSH_WAIVER_FLAGS = ["--repo", "--remote", "--ref", "--findings-file", "--entries-file"] as const;

type PushWaiverFlag = (typeof PUSH_WAIVER_FLAGS)[number];

export type PushWaiverOptions = Readonly<Record<PushWaiverFlag, string>>;

export interface PushWaiverDependencies {
  readonly dataHome: string;
  readonly now: () => Date;
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
}

export const REAL_PUSH_WAIVER_DEPENDENCIES: PushWaiverDependencies = {
  dataHome: RUNTIME_DATA_HOME,
  now: () => new Date(),
  out: (message) => void process.stdout.write(message),
  err: (message) => void process.stderr.write(message),
};

function isPushWaiverFlag(word: string | undefined): word is PushWaiverFlag {
  return (PUSH_WAIVER_FLAGS as readonly (string | undefined)[]).includes(word);
}

export function parsePushWaiverArguments(args: readonly string[]): PushWaiverOptions {
  const options: Partial<Record<PushWaiverFlag, string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1] ?? "";
    if (!isPushWaiverFlag(flag) || options[flag] !== undefined || value.trim() === "") {
      throw new Error(`push-waiver: "${String(flag)}" is unknown, repeated or has no value\n${PUSH_WAIVER_USAGE}`);
    }
    options[flag] = value;
  }
  const missing = PUSH_WAIVER_FLAGS.filter((flag) => options[flag] === undefined);
  if (missing.length > 0) {
    throw new Error(`push-waiver: missing ${missing.join(", ")}\n${PUSH_WAIVER_USAGE}`);
  }
  return options as PushWaiverOptions;
}

async function requireConfiguredRemote(checkout: CourtCheckout, remote: string): Promise<void> {
  const remotes = (await runGit(["remote"], checkout.topLevel)).split("\n");
  if (!remotes.includes(remote)) {
    throw new PushWaiverRefusal(`"${remote}" is not a remote configured in ${checkout.topLevel}.`);
  }
}

async function readLocalBranchCommit(checkout: CourtCheckout, ref: string): Promise<string> {
  const status = await readGitStatus(["rev-parse", "--verify", "--quiet", `refs/heads/${ref}^{commit}`], checkout.topLevel);
  if (status.code !== 0) {
    throw new PushWaiverRefusal(`"${ref}" is not a local branch in ${checkout.topLevel}.`);
  }
  return status.stdout.trim();
}

async function readNamedFile(filePath: string, role: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    throw new PushWaiverRefusal(`cannot read the ${role} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkEveryEntry(waived: readonly WaivedFinding[], checkout: CourtCheckout, pushedCommit: string): Promise<void> {
  for (const { entry } of waived) {
    await checkEntryEvidence(entry, checkout.topLevel, pushedCommit);
  }
}

export interface PreparedWaiver {
  readonly checkout: CourtCheckout;
  readonly record: WaiverRecord;
  readonly waived: readonly WaivedFinding[];
}

export async function prepareWaiver(options: PushWaiverOptions, dependencies: PushWaiverDependencies): Promise<PreparedWaiver> {
  const checkout = await resolveCourtCheckout(options["--repo"], dependencies.dataHome);
  await requireConfiguredRemote(checkout, options["--remote"]);
  const commit = await readLocalBranchCommit(checkout, options["--ref"]);
  const findings = readFindings(await readNamedFile(options["--findings-file"], "findings file"));
  const entries = readEntries(await readNamedFile(options["--entries-file"], "entries file"));
  const waived = pairEntriesWithFindings(findings, entries);
  await checkEveryEntry(waived, checkout, commit);
  const record: WaiverRecord = {
    agent: checkout.agent,
    repo: checkout.topLevel,
    remote: options["--remote"],
    ref: options["--ref"],
    commit,
    writtenAt: dependencies.now().toISOString(),
    findings,
    entries: waived.map(({ entry }) => entry),
  };
  return { checkout, record, waived };
}

function describeEvidence(entry: WaiverEntry): string {
  if ("test" in entry) {
    return `the test "${entry.test}" passes`;
  }
  switch (entry.reason) {
    case PushWaiverReason.OtherOpenPr:
      return `pull request #${entry.pr} at ${entry.commit} provides it at ${formatFileLine(entry.location)}`;
    case PushWaiverReason.AlreadyOnBase:
      return `base ${entry.commit} has it unchanged at ${formatFileLine(entry.location)}`;
    case PushWaiverReason.FindingWrong:
      return `the pushed commit already handles it at ${formatFileLine(entry.location)}`;
  }
}

export function renderWaiverReceipt(recordPath: string, record: WaiverRecord, waived: readonly WaivedFinding[]): string {
  const findingLines = waived.map(
    ({ finding, entry }) =>
      `finding ${finding.number}: ${finding.severity} ${finding.location} ${finding.title} — ${entry.reason}: ${describeEvidence(entry)}`,
  );
  return [
    `push-waiver: waiver written to ${recordPath}`,
    ...findingLines,
    `It covers ${record.commit} pushed to ${record.ref} on ${record.remote}, once. Push with exactly:`,
    `git -C ${record.repo} push --no-verify ${record.remote} ${record.ref}`,
    "",
  ].join("\n");
}

export async function run(
  args: readonly string[],
  dependencies: PushWaiverDependencies = REAL_PUSH_WAIVER_DEPENDENCIES,
): Promise<number> {
  let options: PushWaiverOptions;
  try {
    options = parsePushWaiverArguments(args);
  } catch (error) {
    dependencies.err(
      `${error instanceof Error ? error.message : String(error)}\n${renderEntranceRefusal({
        reason: "push-waiver entrance validation refused this invocation.",
        bypass: undefined,
        supervisorRoute: "Ask your supervisor for an allowed alternative invocation.",
      })}\n`,
    );
    return PushWaiverExitCode.InvalidInvocation;
  }
  try {
    const { checkout, record, waived } = await prepareWaiver(options, dependencies);
    const recordPath = await writeWaiverRecord(checkout.ledger, record);
    dependencies.out(renderWaiverReceipt(recordPath, record, waived));
    return PushWaiverExitCode.Written;
  } catch (error) {
    if (!(error instanceof PushWaiverRefusal)) {
      throw error;
    }
    dependencies.err(`push-waiver: refused, nothing written — ${error.message}\n`);
    return PushWaiverExitCode.Refused;
  }
}
