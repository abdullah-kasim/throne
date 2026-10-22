import os from "node:os";
import path from "node:path";

export const THRONE_HOME_ENV = "THRONE_DATA_HOME";

const THRONE_HOME_FOLDER_NAME = ".throne";

export function resolveThroneHome(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = os.homedir(),
): string {
  const configured = environment[THRONE_HOME_ENV]?.trim();
  const home = configured || path.join(userHome, THRONE_HOME_FOLDER_NAME);
  if (!path.isAbsolute(home)) {
    throw new Error(`${THRONE_HOME_ENV} must be an absolute path`);
  }
  return path.resolve(home);
}

export function throneConfigDirectory(environment?: NodeJS.ProcessEnv, userHome?: string): string {
  return path.join(resolveThroneHome(environment, userHome), "config");
}

export function throneBrowserProfilesDirectory(environment?: NodeJS.ProcessEnv, userHome?: string): string {
  return path.join(resolveThroneHome(environment, userHome), "browser-profiles");
}

export function throneAccountsDirectory(environment?: NodeJS.ProcessEnv, userHome?: string): string {
  return path.join(resolveThroneHome(environment, userHome), "accounts");
}

export function throneLogsDirectory(environment?: NodeJS.ProcessEnv, userHome?: string): string {
  return path.join(resolveThroneHome(environment, userHome), "logs");
}

export function throneHomeOfThisMachine(): string {
  return path.join(os.userInfo().homedir, THRONE_HOME_FOLDER_NAME);
}

export function retiredSettingsDirectory(userHome = os.homedir()): string {
  return path.join(userHome, ".config", "throne");
}

export const THRONE_HOME = resolveThroneHome();
export const THRONE_DATA_DIR = path.join(THRONE_HOME, "data");
