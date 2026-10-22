import { access, chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkFolderLinks, describeLinkCheck, expectedFolderLinks, LinkState, linkSharedItem } from "./account-folder-links.ts";
import { accountFolderPath, standInFolderPath, standInPath, type AccountPlaces } from "./account-places.ts";
import {
  ACCOUNT_HARNESSES,
  parseAccountsConfig,
  primaryClaudeFolder,
  readAccountsConfig,
  writeAccountsConfig,
  type Account,
  type AccountsConfig,
} from "./accounts-config.ts";
import { findAccount } from "./agent-account.ts";

const PRIMARY_ACCOUNT_NAME = "primary";
const CLAUDE_CONFIG_FILE_NAME = ".claude.json";
const MIGRATION_VERSION_KEY = "migrationVersion";
const MIGRATION_COMPLETE_KEY_ENDING = "MigrationComplete";
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const EXECUTABLE_MODE = 0o755;
const LOGIN_ENVIRONMENT_VARIABLES_TO_CLEAR = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
];

export class AccountAddRefusal extends Error {
  readonly name = "AccountAddRefusal";
}

export interface AccountAddDependencies {
  readonly places: AccountPlaces;
  readonly claudeBinary: string;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isSettingsMigrationKey(key: string): boolean {
  return key === MIGRATION_VERSION_KEY || key.endsWith(MIGRATION_COMPLETE_KEY_ENDING);
}

async function settingsMigrationState(userHome: string): Promise<Record<string, unknown>> {
  const primaryConfig = JSON.parse(await readFile(path.join(userHome, CLAUDE_CONFIG_FILE_NAME), "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(primaryConfig).filter(([key]) => isSettingsMigrationKey(key)));
}

async function refuseForeignFolder(folder: string): Promise<void> {
  if (!(await pathExists(folder))) return;
  const entries = await readdir(folder);
  if (entries.length > 0 && !entries.includes(CLAUDE_CONFIG_FILE_NAME)) {
    throw new AccountAddRefusal(`${folder} already holds files and is not a Claude account folder`);
  }
}

function withAccountAdded(config: AccountsConfig | null, account: Account, places: AccountPlaces): AccountsConfig {
  const primary: Account = {
    name: PRIMARY_ACCOUNT_NAME,
    harness: ACCOUNT_HARNESSES.CLAUDE,
    folder: primaryClaudeFolder(places.userHome),
  };
  const current = config ?? { accounts: [primary], mcpServersAllowedOnEveryAccount: [] };
  const registered = findAccount(current, account.name);
  if (registered !== undefined) {
    if (registered.folder !== account.folder) {
      throw new AccountAddRefusal(`account "${account.name}" is already registered with folder ${registered.folder}`);
    }
    return current;
  }
  const updated = { ...current, accounts: [...current.accounts, account] };
  return parseAccountsConfig(JSON.stringify(updated), places.configPath);
}

async function linkSharedFiles(folder: string, userHome: string): Promise<string[]> {
  const checks = await checkFolderLinks(folder, await expectedFolderLinks(primaryClaudeFolder(userHome)));
  const lines: string[] = [];
  for (const check of checks) {
    if (check.state === LinkState.Correct) continue;
    if (check.state === LinkState.NotALink) {
      lines.push(`left as it is, not a link: ${describeLinkCheck(check)}`);
      continue;
    }
    await linkSharedItem(folder, check);
    lines.push(`linked ${check.link.name} -> ${check.link.target}`);
  }
  return lines;
}

async function writeFolderClaudeConfig(folder: string, userHome: string): Promise<string[]> {
  const configPath = path.join(folder, CLAUDE_CONFIG_FILE_NAME);
  if (await pathExists(configPath)) return [];
  const folderConfig = { ...(await settingsMigrationState(userHome)), hasSeenAutoDefaultNudge: true };
  await writeFile(configPath, `${JSON.stringify(folderConfig, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
  return [`wrote ${configPath} with the settings-migration state and the auto-mode nudge flag`];
}

async function installStandIn(places: AccountPlaces): Promise<string[]> {
  const target = standInPath(places);
  if (await pathExists(target)) return [];
  await mkdir(standInFolderPath(places), { recursive: true, mode: PRIVATE_FOLDER_MODE });
  await copyFile(places.repositoryStandInPath, target);
  await chmod(target, EXECUTABLE_MODE);
  return [`installed the Keychain stand-in at ${target}`];
}

export function loginCommandLines(account: Account, places: AccountPlaces, claudeBinary: string): string[] {
  const clearedVariables = LOGIN_ENVIRONMENT_VARIABLES_TO_CLEAR.map((variable) => `-u ${variable}`).join(" ");
  return [
    `To log ${account.name} in, run:`,
    `  env ${clearedVariables} CLAUDE_CONFIG_DIR=${account.folder} PATH="${standInFolderPath(places)}:$PATH" DISABLE_AUTOUPDATER=1 ${claudeBinary}`,
    "then type /login, sign in, then /exit.",
  ];
}

export async function addAccount(name: string, dependencies: AccountAddDependencies): Promise<string[]> {
  const { places } = dependencies;
  const account: Account = { name, harness: ACCOUNT_HARNESSES.CLAUDE, folder: accountFolderPath(places, name) };
  const config = withAccountAdded(readAccountsConfig(places.configPath), account, places);
  await refuseForeignFolder(account.folder);
  await mkdir(account.folder, { recursive: true, mode: PRIVATE_FOLDER_MODE });
  await chmod(account.folder, PRIVATE_FOLDER_MODE);
  const lines = [
    ...(await linkSharedFiles(account.folder, places.userHome)),
    ...(await writeFolderClaudeConfig(account.folder, places.userHome)),
    ...(await installStandIn(places)),
  ];
  await mkdir(path.dirname(places.configPath), { recursive: true });
  await writeAccountsConfig(config, places.configPath);
  lines.push(`recorded ${name} in ${places.configPath}`);
  return [...lines, ...loginCommandLines(account, places, dependencies.claudeBinary)];
}
