import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { isProfileHeldByARunningBrowser } from "./held-browser-profile.ts";
import { MIGRATION_ITEM_KINDS, type MigrationItem } from "./migrate-home-items.ts";

export const ITEM_OUTCOMES = {
  NOTHING_TO_MOVE: "nothing to move",
  LEFT_WHERE_IT_IS: "left where it is, as asked",
  HELD: "held by a running browser, left for a later run",
  MOVED: "moved",
  COPIED: "copied, old copy kept",
  ALREADY_IN_PLACE: "already in place",
  OLD_COPY_REMOVED: "already in place, identical old copy removed",
  REFUSED: "refused, the two copies differ",
} as const;

export type ItemOutcome = (typeof ITEM_OUTCOMES)[keyof typeof ITEM_OUTCOMES];

export interface MigrationChoices {
  readonly keepOldCopies: boolean;
  readonly leaveBrowserProfiles: boolean;
}

export interface ItemDecision {
  readonly item: MigrationItem;
  readonly outcome: ItemOutcome;
  readonly difference?: string;
}

const OUTCOMES_THAT_CHANGE_FILES: readonly ItemOutcome[] = [
  ITEM_OUTCOMES.MOVED,
  ITEM_OUTCOMES.COPIED,
  ITEM_OUTCOMES.OLD_COPY_REMOVED,
];

const OUTCOMES_THAT_EMPTY_THE_OLD_PLACE: readonly ItemOutcome[] = [
  ITEM_OUTCOMES.MOVED,
  ITEM_OUTCOMES.OLD_COPY_REMOVED,
];

export function changesFiles(decision: ItemDecision): boolean {
  return OUTCOMES_THAT_CHANGE_FILES.includes(decision.outcome);
}

export function emptiesTheOldPlace(decision: ItemDecision): boolean {
  return OUTCOMES_THAT_EMPTY_THE_OLD_PLACE.includes(decision.outcome);
}

const runProgram = promisify(execFile);

async function differenceBetween(oldPath: string, newPath: string): Promise<string | undefined> {
  const comparison = (await stat(oldPath)).isDirectory() ? "-rq" : "-u";
  try {
    await runProgram("diff", [comparison, "--no-dereference", oldPath, newPath]);
    return undefined;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trimEnd() || `diff exited ${String(failure.code)}`;
  }
}

async function outcomeFor(item: MigrationItem, choices: MigrationChoices): Promise<ItemDecision> {
  const isBrowserProfile = item.kind === MIGRATION_ITEM_KINDS.BROWSER_PROFILE;
  if (!(await pathExists(item.oldPath))) return { item, outcome: ITEM_OUTCOMES.NOTHING_TO_MOVE };
  if (isBrowserProfile && choices.leaveBrowserProfiles) return { item, outcome: ITEM_OUTCOMES.LEFT_WHERE_IT_IS };
  if (isBrowserProfile && (await isProfileHeldByARunningBrowser(item.oldPath))) return { item, outcome: ITEM_OUTCOMES.HELD };
  if (!(await pathExists(item.newPath))) {
    return { item, outcome: choices.keepOldCopies ? ITEM_OUTCOMES.COPIED : ITEM_OUTCOMES.MOVED };
  }
  if ((await realpath(item.oldPath)) === (await realpath(item.newPath))) {
    return { item, outcome: ITEM_OUTCOMES.ALREADY_IN_PLACE };
  }
  const difference = await differenceBetween(item.oldPath, item.newPath);
  if (difference !== undefined) return { item, outcome: ITEM_OUTCOMES.REFUSED, difference };
  return { item, outcome: choices.keepOldCopies ? ITEM_OUTCOMES.ALREADY_IN_PLACE : ITEM_OUTCOMES.OLD_COPY_REMOVED };
}

export function decideItems(items: readonly MigrationItem[], choices: MigrationChoices): Promise<ItemDecision[]> {
  return Promise.all(items.map((item) => outcomeFor(item, choices)));
}
