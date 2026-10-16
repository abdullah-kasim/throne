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
].join("\n");

export const WhereIStandAction = {
  Show: "show",
  Lock: "lock",
  Note: "note",
  Write: "write",
} as const;

export type WhereIStandArguments =
  | { readonly action: typeof WhereIStandAction.Show }
  | { readonly action: typeof WhereIStandAction.Lock; readonly checksum: string; readonly holdForMilliseconds: number }
  | { readonly action: typeof WhereIStandAction.Note; readonly event: string }
  | { readonly action: typeof WhereIStandAction.Write };

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

export function parseWhereIStandArguments(commandArguments: readonly string[]): WhereIStandArguments {
  if (commandArguments[0] === WhereIStandAction.Write) return { action: WhereIStandAction.Write };
  const { values, positionals } = parseArgs({
    args: [...commandArguments],
    options: {
      checksum: { type: "string" },
      ttl: { type: "string" },
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
  throw new Error(
    action === undefined ? "an action is required: show, lock or note" : `"${action}" is not an action: use show, lock or note`,
  );
}
