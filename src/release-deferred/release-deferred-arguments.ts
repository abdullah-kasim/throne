import { queueAddressingObjectiveCode } from "../shared-policy/objective-contract.ts";

export const RELEASE_DEFERRED_COMMAND = "release-deferred";

export const RELEASE_DEFERRED_USAGE =
  `usage: throne ${RELEASE_DEFERRED_COMMAND} --objective-code <code> --reason <why it may start now> ` +
  "[--requested-by <agent that asked, who is sent the reply>]";

export interface ReleaseDeferredArguments {
  readonly objectiveCode: string;
  readonly reason: string;
  readonly requestedBy: string | null;
}

const FLAG_NAMES = ["--objective-code", "--reason", "--requested-by"] as const;
type FlagName = (typeof FLAG_NAMES)[number];

function isFlagName(value: string): value is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(value);
}

function readFlagValues(args: readonly string[]): Map<FlagName, string> {
  const values = new Map<FlagName, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    if (!isFlagName(flag)) throw new Error(`${RELEASE_DEFERRED_COMMAND}: unknown argument "${flag}"`);
    if (values.has(flag)) throw new Error(`${RELEASE_DEFERRED_COMMAND}: ${flag} was given twice`);
    const value = (args[index + 1] ?? "").trim();
    if (value === "") throw new Error(`${RELEASE_DEFERRED_COMMAND}: ${flag} requires a non-empty value`);
    values.set(flag, value);
  }
  return values;
}

export function parseReleaseDeferredArguments(
  args: readonly string[],
): ReleaseDeferredArguments {
  const values = readFlagValues(args);
  const objectiveCode = queueAddressingObjectiveCode(values.get("--objective-code") ?? "");
  if (objectiveCode === undefined)
    throw new Error(`${RELEASE_DEFERRED_COMMAND}: a valid --objective-code is required`);
  const reason = values.get("--reason");
  if (reason === undefined) throw new Error(`${RELEASE_DEFERRED_COMMAND}: --reason is required`);
  return { objectiveCode, reason, requestedBy: values.get("--requested-by") ?? null };
}
