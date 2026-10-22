import os from "node:os";
import path from "node:path";
import { RUNTIME_THRONE_ROOT } from "../shared-policy/runtime-throne-root.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import { accountsConfigPath, type AccountHarness } from "./accounts-config.ts";

const ACCOUNTS_FOLDER_NAME = "accounts";
const STAND_IN_FOLDER_NAME = "bin";
const STAND_IN_NAME = "security";
const REPOSITORY_STAND_IN_PATH = path.join(RUNTIME_THRONE_ROOT, "src", "account", "security-stand-in");

export interface AccountPlaces {
  readonly configPath: string;
  readonly userHome: string;
  readonly accountsFolder: string;
  readonly repositoryStandInPath: string;
}

export function realAccountPlaces(harness: AccountHarness): AccountPlaces {
  return {
    configPath: accountsConfigPath(),
    userHome: os.homedir(),
    accountsFolder: path.join(resolveThroneHome(), ACCOUNTS_FOLDER_NAME, harness),
    repositoryStandInPath: REPOSITORY_STAND_IN_PATH,
  };
}

export function accountFolderPath(places: AccountPlaces, name: string): string {
  return path.join(places.accountsFolder, name);
}

export function standInFolderPath(places: AccountPlaces): string {
  return path.join(places.accountsFolder, STAND_IN_FOLDER_NAME);
}

export function standInPath(places: AccountPlaces): string {
  return path.join(standInFolderPath(places), STAND_IN_NAME);
}
