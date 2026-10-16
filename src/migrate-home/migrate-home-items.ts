import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  retiredSettingsDirectory,
  throneBrowserProfilesDirectory,
  throneConfigDirectory,
} from "../shared-policy/throne-home.ts";
import { pathExists } from "../git-lifecycle/git-command.service.ts";
import { checkoutUserConfigPath, homeUserConfigPath } from "../user-config-loader.ts";

export const RETIRED_BROWSER_PROFILES_FOLDER_NAME = "agent-browser";

const SETTINGS_FILE_NAMES = ["features.json", "private-refs.txt"] as const;

export const MIGRATION_ITEM_KINDS = {
  SETTING: "setting",
  BROWSER_PROFILE: "browser profile",
  CHECKOUT_CONFIG: "checkout config",
} as const;

export type MigrationItemKind = (typeof MIGRATION_ITEM_KINDS)[keyof typeof MIGRATION_ITEM_KINDS];

export interface MigrationItem {
  readonly kind: MigrationItemKind;
  readonly oldPath: string;
  readonly newPath: string;
}

export interface ThroneHomeLocations {
  readonly environment: NodeJS.ProcessEnv;
  readonly userHome: string;
  readonly checkoutRoot: string | undefined;
}

function settingItems(locations: ThroneHomeLocations): MigrationItem[] {
  return SETTINGS_FILE_NAMES.map((fileName) => ({
    kind: MIGRATION_ITEM_KINDS.SETTING,
    oldPath: path.join(retiredSettingsDirectory(locations.userHome), fileName),
    newPath: path.join(throneConfigDirectory(locations.environment, locations.userHome), fileName),
  }));
}

export function retiredBrowserProfilesDirectory(userHome: string): string {
  return path.join(retiredSettingsDirectory(userHome), RETIRED_BROWSER_PROFILES_FOLDER_NAME);
}

async function browserProfileItems(locations: ThroneHomeLocations): Promise<MigrationItem[]> {
  const oldProfiles = retiredBrowserProfilesDirectory(locations.userHome);
  if (!(await pathExists(oldProfiles))) return [];
  return (await readdir(oldProfiles, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      kind: MIGRATION_ITEM_KINDS.BROWSER_PROFILE,
      oldPath: path.join(oldProfiles, entry.name),
      newPath: path.join(throneBrowserProfilesDirectory(locations.environment, locations.userHome), entry.name),
    }));
}

function checkoutConfigItems(locations: ThroneHomeLocations): MigrationItem[] {
  if (locations.checkoutRoot === undefined) return [];
  return [
    {
      kind: MIGRATION_ITEM_KINDS.CHECKOUT_CONFIG,
      oldPath: checkoutUserConfigPath(locations.checkoutRoot),
      newPath: homeUserConfigPath(locations.environment),
    },
  ];
}

export async function listMigrationItems(locations: ThroneHomeLocations): Promise<MigrationItem[]> {
  return [...settingItems(locations), ...(await browserProfileItems(locations)), ...checkoutConfigItems(locations)];
}
