import { access, constants as fileAccess } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClaudeConfigTarget } from "../claude-spawn-trust/claude-worktree-trust.ts";
import {
  accountsConfigPath,
  isPrimaryAccount,
  readAccountsConfig,
  type Account,
  type AccountsConfig,
} from "./accounts-config.ts";
import {
  claudeAccountConfigFilePath,
  claudeAccountsDirectory,
  primaryClaudeConfigFilePath,
  readClaudeAccountLogin,
} from "./claude-account-adapter.ts";
import {
  claudeAccountMcpServersFilePath,
  mcpServersForAccount,
  readPrimaryMcpServers,
  writeClaudeAccountMcpServersFile,
} from "./claude-mcp-servers.ts";

export const VARIABLES_UNSET_FOR_ANOTHER_ACCOUNT_FOLDER = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

const SECURITY_STAND_IN_FOLDER_NAME = "bin";
const SECURITY_STAND_IN_NAME = "security";
const MCP_CONFIG_FLAG = "--mcp-config";
const STRICT_MCP_CONFIG_FLAG = "--strict-mcp-config";
const CLAUDE_AI_CONNECTORS_OFF = { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } as const;
const AUTO_UPDATER_OFF = { DISABLE_AUTOUPDATER: "1" } as const;

export interface AccountHome {
  readonly environment: NodeJS.ProcessEnv;
  readonly userHome: string;
}

export interface ClaudeAccountLaunch {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly unsetVariables: readonly string[];
  readonly prependedPath?: string;
  readonly trustTarget: ClaudeConfigTarget;
}

export class UnknownLaunchAccountError extends Error {
  readonly name = "UnknownLaunchAccountError";

  constructor(accountName: string, config: AccountsConfig) {
    super(
      `cannot launch on account "${accountName}": it is not in the accounts config (configured: ${config.accounts.map((account) => account.name).join(", ")})`,
    );
  }
}

export class SecurityStandInMissingError extends Error {
  readonly name = "SecurityStandInMissingError";

  constructor(standInPath: string) {
    super(
      `cannot launch on another Claude account folder: the security stand-in "${standInPath}" is missing or not executable, so its login would land in the macOS Keychain`,
    );
  }
}

export function realAccountHome(): AccountHome {
  return { environment: process.env, userHome: os.homedir() };
}

export function claudeSecurityStandInFolder(home: AccountHome): string {
  return path.join(claudeAccountsDirectory(home.environment, home.userHome), SECURITY_STAND_IN_FOLDER_NAME);
}

function findConfiguredAccount(config: AccountsConfig, accountName: string): Account {
  const account = config.accounts.find((candidate) => candidate.name === accountName);
  if (account === undefined) throw new UnknownLaunchAccountError(accountName, config);
  return account;
}

async function requireSecurityStandIn(standInFolder: string): Promise<void> {
  const standInPath = path.join(standInFolder, SECURITY_STAND_IN_NAME);
  try {
    await access(standInPath, fileAccess.X_OK);
  } catch {
    throw new SecurityStandInMissingError(standInPath);
  }
}

async function accountFolderLaunch(
  account: Account,
  home: AccountHome,
): Promise<Pick<ClaudeAccountLaunch, "env" | "unsetVariables" | "prependedPath">> {
  if (isPrimaryAccount(account, home.userHome)) return { env: {}, unsetVariables: [] };
  const standInFolder = claudeSecurityStandInFolder(home);
  await requireSecurityStandIn(standInFolder);
  return {
    env: { CLAUDE_CONFIG_DIR: account.folder, ...AUTO_UPDATER_OFF },
    unsetVariables: VARIABLES_UNSET_FOR_ANOTHER_ACCOUNT_FOLDER,
    prependedPath: standInFolder,
  };
}

async function mcpServersFileFor(
  account: Account,
  isCompanyAccount: boolean,
  config: AccountsConfig,
  home: AccountHome,
): Promise<string> {
  const servers = mcpServersForAccount(
    await readPrimaryMcpServers(primaryClaudeConfigFilePath(home.userHome)),
    isCompanyAccount,
    config.mcpServersAllowedOnEveryAccount,
  );
  const filePath = claudeAccountMcpServersFilePath(account.name, home.environment, home.userHome);
  await writeClaudeAccountMcpServersFile(filePath, servers);
  return filePath;
}

export async function claudeAccountLaunch(
  accountName: string,
  home: AccountHome = realAccountHome(),
): Promise<ClaudeAccountLaunch | null> {
  const config = readAccountsConfig(accountsConfigPath(home.environment, home.userHome));
  if (config === null) return null;
  const account = findConfiguredAccount(config, accountName);
  const folderLaunch = await accountFolderLaunch(account, home);
  const { isCompany } = await readClaudeAccountLogin(account, config.companyLogin, { userHome: home.userHome });
  return {
    argv: [
      MCP_CONFIG_FLAG,
      await mcpServersFileFor(account, isCompany, config, home),
      ...(isCompany ? [] : [STRICT_MCP_CONFIG_FLAG]),
    ],
    env: { ...folderLaunch.env, ...(isCompany ? {} : CLAUDE_AI_CONNECTORS_OFF) },
    unsetVariables: folderLaunch.unsetVariables,
    ...(folderLaunch.prependedPath !== undefined ? { prependedPath: folderLaunch.prependedPath } : {}),
    trustTarget: {
      configPath: claudeAccountConfigFilePath(account, home.userHome),
      dismissesAutoModeNudge: !isPrimaryAccount(account, home.userHome),
    },
  };
}
