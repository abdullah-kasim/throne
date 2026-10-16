import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { throneConfigDirectory } from "../shared-policy/throne-home.ts";
import { writeHomeConfigModulePackageIfMissing } from "../user-config-loader.ts";
import {
  changesFiles,
  decideItems,
  emptiesTheOldPlace,
  ITEM_OUTCOMES,
  type ItemDecision,
  type MigrationChoices,
} from "./migrate-home-decision.ts";
import {
  listMigrationItems,
  MIGRATION_ITEM_KINDS,
  type MigrationItem,
  type ThroneHomeLocations,
} from "./migrate-home-items.ts";

export const MOVED_NOTE_FILE_NAME = "MOVED.txt";

const MODULE_PACKAGE_FILE_NAME = "package.json";

export interface ThroneHomeMigrationRequest extends ThroneHomeLocations, MigrationChoices {
  readonly backupDirectory: string;
}

export interface ThroneHomeMigrationReport {
  readonly lines: readonly string[];
  readonly refused: boolean;
  readonly backupDirectory: string | undefined;
}

const COPY_OPTIONS = { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false } as const;

async function backUpItems(items: readonly MigrationItem[], backupDirectory: string): Promise<void> {
  for (const touchedPath of items.flatMap((item) => [item.oldPath, item.newPath])) {
    if (!(await pathExists(touchedPath))) continue;
    const backupPath = path.join(backupDirectory, touchedPath);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await cp(touchedPath, backupPath, COPY_OPTIONS);
  }
}

async function applyDecision(decision: ItemDecision): Promise<void> {
  const { oldPath, newPath } = decision.item;
  if (decision.outcome === ITEM_OUTCOMES.OLD_COPY_REMOVED) {
    await rm(oldPath, { recursive: true });
    return;
  }
  await mkdir(path.dirname(newPath), { recursive: true });
  if (decision.outcome === ITEM_OUTCOMES.MOVED) await rename(oldPath, newPath);
  else await cp(oldPath, newPath, COPY_OPTIONS);
}

function movedNoteLine(item: MigrationItem): string {
  return `${path.basename(item.oldPath)} -> ${item.newPath}`;
}

async function recordMovedItems(items: readonly MigrationItem[]): Promise<void> {
  const oldFolders = new Set(items.map((item) => path.dirname(item.oldPath)));
  for (const oldFolder of oldFolders) {
    const notePath = path.join(oldFolder, MOVED_NOTE_FILE_NAME);
    const earlierLines = (await pathExists(notePath)) ? (await readFile(notePath, "utf8")).split("\n") : [];
    const newLines = items.filter((item) => path.dirname(item.oldPath) === oldFolder).map(movedNoteLine);
    const lines = [...new Set([...earlierLines, ...newLines].filter((line) => line !== ""))].sort();
    await writeFile(notePath, `${lines.join("\n")}\n`);
  }
}

function placesConfigInTheHome(decision: ItemDecision): boolean {
  return (
    decision.item.kind === MIGRATION_ITEM_KINDS.CHECKOUT_CONFIG &&
    (decision.outcome === ITEM_OUTCOMES.MOVED || decision.outcome === ITEM_OUTCOMES.COPIED)
  );
}

async function homeConfigFolderIsMarkedAsModule(environment: NodeJS.ProcessEnv): Promise<boolean> {
  const packagePath = path.join(throneConfigDirectory(environment), MODULE_PACKAGE_FILE_NAME);
  try {
    return (JSON.parse(await readFile(packagePath, "utf8")) as { type?: unknown }).type === "module";
  } catch {
    return false;
  }
}

async function markPlacedConfigAsModule(
  decisions: readonly ItemDecision[],
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!decisions.some(placesConfigInTheHome)) return undefined;
  await writeHomeConfigModulePackageIfMissing(environment);
  if (await homeConfigFolderIsMarkedAsModule(environment)) return undefined;
  const packagePath = path.join(throneConfigDirectory(environment), MODULE_PACKAGE_FILE_NAME);
  return `${ITEM_OUTCOMES.REFUSED}: ${packagePath} exists and does not say "type": "module"; config.user.ts there will not load quietly`;
}

function describeDecision(decision: ItemDecision): string {
  const line = `${decision.outcome}: ${decision.item.oldPath} -> ${decision.item.newPath}`;
  return decision.difference === undefined ? line : `${line}\n${decision.difference}`;
}

export async function migrateThroneHome(request: ThroneHomeMigrationRequest): Promise<ThroneHomeMigrationReport> {
  const decisions = await decideItems(await listMigrationItems(request), request);
  const changing = decisions.filter(changesFiles);
  if (changing.length > 0) await backUpItems(changing.map((decision) => decision.item), request.backupDirectory);
  for (const decision of changing) await applyDecision(decision);
  await recordMovedItems(changing.filter(emptiesTheOldPlace).map((decision) => decision.item));
  const moduleMarkerRefusal = await markPlacedConfigAsModule(decisions, request.environment);
  const lines = decisions.map(describeDecision);
  if (moduleMarkerRefusal !== undefined) lines.push(moduleMarkerRefusal);
  return {
    lines,
    refused: moduleMarkerRefusal !== undefined || decisions.some((decision) => decision.outcome === ITEM_OUTCOMES.REFUSED),
    backupDirectory: changing.length > 0 ? request.backupDirectory : undefined,
  };
}
