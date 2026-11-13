import { parseArgs } from "node:util";
import { LOCAL_FLAG } from "../where-i-stand-store/where-i-stand-client.ts";

export const WHERE_I_STAND_USAGE = [
  `usage: throne where-i-stand list [${LOCAL_FLAG}]`,
  `       throne where-i-stand show [${LOCAL_FLAG}]`,
  '       throne where-i-stand put --code <objective code or repo#number> --section-id <id from list> --listing-token <token from list> (--text-file <file> | --text "<entry body>")',
  "       throne where-i-stand put --code <objective code or repo#number> --remove",
  '       throne where-i-stand note "<one line>"',
  "       throne where-i-stand archive <row or section id>",
  "       throne where-i-stand restore <row or section id>",
  "       throne where-i-stand purge [--dry-run]",
  '       throne where-i-stand add-tab --name "<tab name>" --listing-token <token from list>',
  '       throne where-i-stand add-section --tab-id <id> [--parent-id <section id>] --name "<section name>" --listing-token <token from list>',
  `Every action reaches throne-backend; add ${LOCAL_FLAG} to open the database in this process instead.`,
].join("\n");

export const WhereIStandAction = {
  List: "list",
  Show: "show",
  Put: "put",
  Note: "note",
  Archive: "archive",
  Restore: "restore",
  Purge: "purge",
  AddTab: "add-tab",
  AddSection: "add-section",
} as const;

const ACTIONS: readonly string[] = Object.values(WhereIStandAction);

export type EntryText = { readonly text: string } | { readonly textFile: string };

export type SectionChoice = { readonly sectionName: string } | { readonly sectionId: string; readonly listingToken: string };

type Request =
  | { readonly action: typeof WhereIStandAction.List }
  | { readonly action: typeof WhereIStandAction.Show }
  | { readonly action: typeof WhereIStandAction.Put; readonly code: string; readonly remove: true }
  | { readonly action: typeof WhereIStandAction.Put; readonly code: string; readonly section: SectionChoice; readonly entry: EntryText }
  | { readonly action: typeof WhereIStandAction.Note; readonly event: string }
  | { readonly action: typeof WhereIStandAction.Archive; readonly id: string }
  | { readonly action: typeof WhereIStandAction.Restore; readonly id: string }
  | { readonly action: typeof WhereIStandAction.Purge; readonly dryRun: boolean }
  | { readonly action: typeof WhereIStandAction.AddTab; readonly name: string; readonly listingToken: string }
  | {
      readonly action: typeof WhereIStandAction.AddSection;
      readonly tabId: string;
      readonly parentId: string | undefined;
      readonly name: string;
      readonly listingToken: string;
    };

export type WhereIStandArguments = Request & { readonly local: boolean };

const OPTIONS = {
  local: { type: "boolean" },
  code: { type: "string" },
  section: { type: "string" },
  "section-id": { type: "string" },
  "listing-token": { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  remove: { type: "boolean" },
  "dry-run": { type: "boolean" },
  name: { type: "string" },
  "tab-id": { type: "string" },
  "parent-id": { type: "string" },
} as const;

type Values = { readonly [Name in keyof typeof OPTIONS]?: (typeof OPTIONS)[Name]["type"] extends "boolean" ? boolean : string };

const FLAGS_OF_EACH_ACTION: Record<string, readonly (keyof typeof OPTIONS)[]> = {
  [WhereIStandAction.Put]: ["code", "section", "section-id", "listing-token", "text", "text-file", "remove"],
  [WhereIStandAction.Purge]: ["dry-run"],
  [WhereIStandAction.AddTab]: ["name", "listing-token"],
  [WhereIStandAction.AddSection]: ["tab-id", "parent-id", "name", "listing-token"],
};

function required(values: Values, flag: "code" | "listing-token" | "name" | "tab-id", action: string): string {
  const value = (values[flag] ?? "").trim();
  if (value === "") throw new Error(`${action} needs --${flag}`);
  return value;
}

function oneLineEventOf(text: string | undefined): string {
  const event = (text ?? "").trim();
  if (event === "") throw new Error('note needs the event as one argument: note "<one line>"');
  if (event.includes("\n")) throw new Error("a note is one line; this one has a line break");
  return event;
}

function sectionChoiceOf(values: Values): SectionChoice {
  const sectionName = values.section?.trim();
  const sectionId = values["section-id"]?.trim();
  if (sectionName !== undefined && sectionId !== undefined) throw new Error("put takes --section or --section-id, not both");
  if (sectionName) {
    if (values["listing-token"] !== undefined) throw new Error("--listing-token goes with --section-id, not --section");
    return { sectionName };
  }
  if (!sectionId) throw new Error("put needs --section-id <id from list> and --listing-token <token from list>");
  return { sectionId, listingToken: required(values, "listing-token", "put --section-id") };
}

function putRequestOf(values: Values): Request {
  const code = required(values, "code", "put");
  if (values.remove === true) {
    if ([values.section, values["section-id"], values["listing-token"], values.text, values["text-file"]].some((value) => value !== undefined)) {
      throw new Error("put --remove takes only --code");
    }
    return { action: WhereIStandAction.Put, code, remove: true };
  }
  const section = sectionChoiceOf(values);
  if ((values.text === undefined) === (values["text-file"] === undefined)) throw new Error("put needs exactly one of --text and --text-file");
  const entry = values["text-file"] === undefined ? { text: values.text! } : { textFile: values["text-file"] };
  return { action: WhereIStandAction.Put, code, section, entry };
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

function requestOf(action: string, values: Values, rest: readonly string[]): Request {
  const allowed = FLAGS_OF_EACH_ACTION[action] ?? [];
  const stray = (Object.keys(values) as (keyof typeof OPTIONS)[]).filter((flag) => flag !== "local" && !allowed.includes(flag));
  if (stray.length > 0) throw new Error(`${stray.map((flag) => `--${flag}`).join(", ")} do not belong to ${action}`);
  if (action === WhereIStandAction.Note) {
    if (rest.length > 1) throw new Error("note takes the event as one quoted argument");
    return { action, event: oneLineEventOf(rest[0]) };
  }
  if (action === WhereIStandAction.Archive || action === WhereIStandAction.Restore) {
    if (rest.length !== 1) throw new Error(`${action} takes one row or section id, such as r12 or s3`);
    return { action, id: rest[0].trim() };
  }
  if (rest.length > 0) throw new Error(`${action} takes no argument besides its flags, got "${rest.join(" ")}"`);
  if (action === WhereIStandAction.List || action === WhereIStandAction.Show) return { action };
  if (action === WhereIStandAction.Put) return putRequestOf(values);
  if (action === WhereIStandAction.Purge) return { action, dryRun: values["dry-run"] === true };
  if (action === WhereIStandAction.AddTab) {
    return { action, name: required(values, "name", action), listingToken: required(values, "listing-token", action) };
  }
  return {
    action: WhereIStandAction.AddSection,
    tabId: required(values, "tab-id", action),
    parentId: values["parent-id"]?.trim() || undefined,
    name: required(values, "name", action),
    listingToken: required(values, "listing-token", action),
  };
}

export function parseWhereIStandArguments(commandArguments: readonly string[]): WhereIStandArguments {
  const { values, positionals } = parseArgs({
    args: withTextJoinedToItsFlag(commandArguments),
    options: OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const [action, ...rest] = positionals;
  if (action === undefined || !ACTIONS.includes(action)) {
    const known = ACTIONS.join(", ");
    throw new Error(action === undefined ? `an action is required: ${known}` : `"${action}" is not an action: use ${known}`);
  }
  return { ...requestOf(action, values as Values, rest), local: values.local === true };
}
