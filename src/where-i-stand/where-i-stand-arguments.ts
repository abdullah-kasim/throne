import { parseArgs } from "node:util";

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
export const DEFAULT_LOCK_DURATION = "5m";
export const LONGEST_LOCK_MILLISECONDS = 15 * MILLISECONDS_PER_MINUTE;
const LOCK_DURATION_FORM = /^(\d+)(s|m)$/;

export const WHERE_I_STAND_USAGE = [
  "usage: throne where-i-stand show",
  `       throne where-i-stand lock --checksum <checksum> [--ttl <seconds>s|<minutes>m, default ${DEFAULT_LOCK_DURATION}, at most 15m]`,
  '       throne where-i-stand note "<one line>"',
  '       throne where-i-stand put --code <objective code or repo#number> --section "<section name as on the page>" (--text-file <file> | --text "<entry body>")',
  "       throne where-i-stand put --code <objective code or repo#number> --remove",
  '       throne where-i-stand save < {"loaded": "<entry as the page loaded it>", "edited": "<its new text>"}',
].join("\n");

export const WhereIStandAction = {
  Show: "show",
  Lock: "lock",
  Note: "note",
  Put: "put",
  Write: "write",
  Save: "save",
} as const;

export type WhereIStandArguments =
  | { readonly action: typeof WhereIStandAction.Show }
  | { readonly action: typeof WhereIStandAction.Lock; readonly checksum: string; readonly holdForMilliseconds: number }
  | { readonly action: typeof WhereIStandAction.Note; readonly event: string }
  | { readonly action: typeof WhereIStandAction.Put; readonly code: string; readonly remove: true }
  | {
      readonly action: typeof WhereIStandAction.Put;
      readonly code: string;
      readonly section: string;
      readonly text: string | undefined;
      readonly textFile: string | undefined;
    }
  | { readonly action: typeof WhereIStandAction.Write }
  | { readonly action: typeof WhereIStandAction.Save };

function oneLineEventOf(text: string | undefined): string {
  const event = (text ?? "").trim();
  if (event === "") throw new Error('note needs the event as one argument: note "<one line>"');
  if (event.includes("\n")) throw new Error("a note is one line; this one has a line break");
  return event;
}

function lockMillisecondsOf(duration: string): number {
  const match = LOCK_DURATION_FORM.exec(duration);
  if (match === null) throw new Error(`--ttl takes a whole number of seconds or minutes, such as 90s or 5m, got "${duration}"`);
  const milliseconds = Number(match[1]) * (match[2] === "m" ? MILLISECONDS_PER_MINUTE : MILLISECONDS_PER_SECOND);
  if (milliseconds === 0) throw new Error("--ttl must be longer than zero");
  if (milliseconds > LONGEST_LOCK_MILLISECONDS) throw new Error(`--ttl may be at most 15m, got "${duration}"`);
  return milliseconds;
}

interface PutValues {
  readonly checksum?: string;
  readonly ttl?: string;
  readonly code?: string;
  readonly section?: string;
  readonly text?: string;
  readonly "text-file"?: string;
  readonly remove?: boolean;
}

function putArgumentsOf(values: PutValues, rest: readonly string[]): WhereIStandArguments {
  if (rest.length > 0) throw new Error(`put takes no argument besides its flags, got "${rest.join(" ")}"`);
  if (values.checksum !== undefined || values.ttl !== undefined) throw new Error("--checksum and --ttl belong to lock only");
  const code = (values.code ?? "").trim();
  if (code === "") throw new Error("put needs --code <objective code or repo#number>");
  const textFile = values["text-file"];
  if (values.remove === true) {
    if (values.section !== undefined || values.text !== undefined || textFile !== undefined) {
      throw new Error("put --remove takes only --code");
    }
    return { action: WhereIStandAction.Put, code, remove: true };
  }
  const section = (values.section ?? "").trim();
  if (section === "") throw new Error('put needs --section "<section name as on the page>"');
  if ((values.text === undefined) === (textFile === undefined)) throw new Error("put needs exactly one of --text and --text-file");
  return { action: WhereIStandAction.Put, code, section, text: values.text, textFile };
}

function withTextJoinedToItsFlag(commandArguments: readonly string[]): string[] {
  const joined: string[] = [];
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index];
    const value = commandArguments[index + 1];
    if (argument === "--text" && value !== undefined) {
      joined.push(`--text=${value}`);
      index += 1;
    } else {
      joined.push(argument);
    }
  }
  return joined;
}

export function parseWhereIStandArguments(commandArguments: readonly string[]): WhereIStandArguments {
  if (commandArguments[0] === WhereIStandAction.Write) return { action: WhereIStandAction.Write };
  const { values, positionals } = parseArgs({
    args: withTextJoinedToItsFlag(commandArguments),
    options: {
      checksum: { type: "string" },
      ttl: { type: "string" },
      code: { type: "string" },
      section: { type: "string" },
      text: { type: "string" },
      "text-file": { type: "string" },
      remove: { type: "boolean" },
    },
    strict: true,
    allowPositionals: true,
  });
  const [action, ...rest] = positionals;
  if (action === WhereIStandAction.Lock) {
    if (rest.length > 0) throw new Error(`lock takes no argument besides its flags, got "${rest.join(" ")}"`);
    const checksum = (values.checksum ?? "").trim();
    if (checksum === "") throw new Error('lock needs --checksum <checksum>, the checksum "show" printed');
    return { action, checksum, holdForMilliseconds: lockMillisecondsOf(values.ttl ?? DEFAULT_LOCK_DURATION) };
  }
  if (action === WhereIStandAction.Put) return putArgumentsOf(values, rest);
  if ([values.code, values.section, values.text, values["text-file"], values.remove].some((value) => value !== undefined)) {
    throw new Error("--code, --section, --text, --text-file and --remove belong to put only");
  }
  if (values.checksum !== undefined || values.ttl !== undefined) {
    throw new Error("--checksum and --ttl belong to lock only");
  }
  if (action === WhereIStandAction.Show) {
    if (rest.length > 0) throw new Error(`show takes no argument, got "${rest.join(" ")}"`);
    return { action };
  }
  if (action === WhereIStandAction.Note) {
    if (rest.length > 1) throw new Error("note takes the event as one quoted argument");
    return { action, event: oneLineEventOf(rest[0]) };
  }
  if (action === WhereIStandAction.Save) {
    if (rest.length > 0) throw new Error(`save takes no argument; it reads its JSON from standard input, got "${rest.join(" ")}"`);
    return { action };
  }
  throw new Error(
    action === undefined ? "an action is required: show, lock, note, put or save" : `"${action}" is not an action: use show, lock, note, put or save`,
  );
}
