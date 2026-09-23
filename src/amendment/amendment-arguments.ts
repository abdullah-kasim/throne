import { queueAddressingObjectiveCode } from "../shared-policy/objective-contract.ts";

export interface AmendmentArguments {
  readonly objectiveCode: string;
  readonly wordsOf: string;
  readonly relayedBy?: string;
  readonly text?: string;
  readonly textFile?: string;
}

export const AMENDMENT_USAGE =
  "usage: throne amendment --objective-code <code> --words-of <whose words, e.g. Lord> " +
  "(--text <amendment> | --text-file <path>) [--relayed-by <agent name, default: you>]";

const VALUE_FLAGS: ReadonlyMap<string, keyof AmendmentArguments> = new Map([
  ["--objective-code", "objectiveCode"],
  ["--words-of", "wordsOf"],
  ["--relayed-by", "relayedBy"],
  ["--text", "text"],
  ["--text-file", "textFile"],
]);

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.trim() === "") {
    throw new Error(`amendment: ${flag} requires a non-empty value`);
  }
  return value;
}

export function parseAmendmentArguments(args: readonly string[]): AmendmentArguments {
  const values = new Map<keyof AmendmentArguments, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    const field = VALUE_FLAGS.get(flag);
    if (field === undefined) {
      throw new Error(`amendment: unknown argument "${flag}"`);
    }
    if (values.has(field)) {
      throw new Error(`amendment: ${flag} was given twice`);
    }
    values.set(field, readFlagValue(args, index, flag));
    index += 1;
  }
  const rawObjectiveCode = values.get("objectiveCode");
  const objectiveCode =
    rawObjectiveCode === undefined ? undefined : queueAddressingObjectiveCode(rawObjectiveCode);
  if (objectiveCode === undefined) {
    throw new Error("amendment: a valid --objective-code is required");
  }
  const wordsOf = values.get("wordsOf");
  if (wordsOf === undefined) {
    throw new Error(
      "amendment: --words-of is required: name whose words these are (normally Lord). " +
        "Only the Lord's own words may amend a campaign.",
    );
  }
  const text = values.get("text");
  const textFile = values.get("textFile");
  if ((text === undefined) === (textFile === undefined)) {
    throw new Error("amendment: give exactly one of --text or --text-file");
  }
  const relayedBy = values.get("relayedBy");
  return {
    objectiveCode,
    wordsOf,
    ...(relayedBy === undefined ? {} : { relayedBy }),
    ...(text === undefined ? {} : { text }),
    ...(textFile === undefined ? {} : { textFile }),
  };
}
