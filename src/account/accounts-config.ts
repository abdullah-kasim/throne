import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathsResolveEqual } from "../shared-policy/path-equivalence.ts";
import { throneConfigDirectory } from "../shared-policy/throne-home.ts";

export const ACCOUNTS_CONFIG_FILE_NAME = "accounts.json";

export const ACCOUNT_HARNESSES = {
  CLAUDE: "claude",
} as const;
export type AccountHarness = (typeof ACCOUNT_HARNESSES)[keyof typeof ACCOUNT_HARNESSES];

export const COMPANY_ACCOUNT_WORD = "company";

export const ACCOUNTS_CONFIG_KEYS = [
  "accounts",
  "longRunningAccount",
  "companyLogin",
  "mcpServersAllowedOnEveryAccount",
  "balancing",
  "providerAccounts",
] as const;
export const ACCOUNT_KEYS = ["name", "harness", "folder"] as const;
export const PROVIDER_ACCOUNT_KEYS = ["name", "provider", "harness", "keyFile"] as const;
export const PROVIDER_HARNESSES = {
  deepseek: "pi",
} as const;
export type Provider = keyof typeof PROVIDER_HARNESSES;
export const COMPANY_LOGIN_KEYS = ["emailDomain", "organizationUuid"] as const;

export const ACCOUNT_NAME_SHAPE = /^[a-z]+$/;
const PRIMARY_CLAUDE_FOLDER_NAME = ".claude";

export interface Account {
  readonly name: string;
  readonly harness: AccountHarness;
  readonly folder: string;
}

export interface ProviderAccount {
  readonly name: string;
  readonly provider: Provider;
  readonly harness: (typeof PROVIDER_HARNESSES)[Provider];
  readonly keyFile: string;
}

export interface ProviderOnlyAccountsFile {
  readonly providerAccounts: readonly ProviderAccount[];
}

export interface AccountsFile {
  readonly config: AccountsConfig | null;
  readonly providerAccounts: readonly ProviderAccount[];
}

export interface CompanyLogin {
  readonly emailDomain?: string;
  readonly organizationUuid?: string;
}

export interface AccountsConfig {
  readonly accounts: readonly Account[];
  readonly longRunningAccount?: string;
  readonly companyLogin?: CompanyLogin;
  readonly mcpServersAllowedOnEveryAccount: readonly string[];
  readonly balancing?: boolean;
  readonly providerAccounts?: readonly ProviderAccount[];
}

export class AccountsConfigError extends Error {
  constructor(sourcePath: string, problem: string) {
    super(`Invalid throne accounts config in "${sourcePath}": ${problem}`);
    this.name = "AccountsConfigError";
  }
}

export function accountsConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): string {
  return path.join(throneConfigDirectory(environment, userHome), ACCOUNTS_CONFIG_FILE_NAME);
}

export function primaryClaudeFolder(userHome: string = os.homedir()): string {
  return path.join(userHome, PRIMARY_CLAUDE_FOLDER_NAME);
}

export function isPrimaryAccount(account: Account, userHome: string = os.homedir()): boolean {
  return pathsResolveEqual(account.folder, primaryClaudeFolder(userHome));
}

export function primaryAccountOf(config: AccountsConfig, userHome: string = os.homedir()): Account {
  return config.accounts.find((account) => isPrimaryAccount(account, userHome)) ?? config.accounts[0]!;
}

export function isBalancingOn(config: AccountsConfig): boolean {
  return config.balancing !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function refuseUnknownKeys(
  record: Record<string, unknown>,
  knownKeys: readonly string[],
  where: string,
  sourcePath: string,
): void {
  const unknownKey = Object.keys(record).find((key) => !knownKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new AccountsConfigError(sourcePath, `unknown key "${unknownKey}" in ${where}`);
  }
}

function parseAccount(value: unknown, index: number, sourcePath: string): Account {
  const where = `accounts[${index}]`;
  if (!isRecord(value)) throw new AccountsConfigError(sourcePath, `${where} must be an object`);
  refuseUnknownKeys(value, ACCOUNT_KEYS, where, sourcePath);
  const { name, harness, folder } = value;
  if (typeof name !== "string" || !ACCOUNT_NAME_SHAPE.test(name)) {
    throw new AccountsConfigError(sourcePath, `${where}.name must be one plain lowercase word`);
  }
  if (name === COMPANY_ACCOUNT_WORD) {
    throw new AccountsConfigError(
      sourcePath,
      `${where}.name "${COMPANY_ACCOUNT_WORD}" is reserved for the company login`,
    );
  }
  if (!(Object.values(ACCOUNT_HARNESSES) as unknown[]).includes(harness)) {
    throw new AccountsConfigError(
      sourcePath,
      `${where}.harness must be one of ${Object.values(ACCOUNT_HARNESSES).join(", ")}`,
    );
  }
  if (typeof folder !== "string" || !path.isAbsolute(folder)) {
    throw new AccountsConfigError(sourcePath, `${where}.folder must be an absolute path`);
  }
  return { name, harness: harness as AccountHarness, folder };
}

function parseAccounts(value: unknown, sourcePath: string): Account[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AccountsConfigError(sourcePath, `"accounts" must be a non-empty list`);
  }
  const accounts = value.map((item, index) => parseAccount(item, index, sourcePath));
  const repeatedName = accounts.find(
    (account, index) => accounts.findIndex((other) => other.name === account.name) !== index,
  );
  if (repeatedName !== undefined) {
    throw new AccountsConfigError(sourcePath, `account name "${repeatedName.name}" is listed twice`);
  }
  return accounts;
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && Object.hasOwn(PROVIDER_HARNESSES, value);
}

function parseProviderAccount(value: unknown, index: number, sourcePath: string): ProviderAccount {
  const where = `providerAccounts[${index}]`;
  if (!isRecord(value)) throw new AccountsConfigError(sourcePath, `${where} must be an object`);
  refuseUnknownKeys(value, PROVIDER_ACCOUNT_KEYS, where, sourcePath);
  const { name, provider, harness, keyFile } = value;
  if (typeof name !== "string" || !ACCOUNT_NAME_SHAPE.test(name) || name === COMPANY_ACCOUNT_WORD) {
    throw new AccountsConfigError(sourcePath, `${where}.name must be one plain lowercase word other than "${COMPANY_ACCOUNT_WORD}"`);
  }
  if (!isProvider(provider)) {
    throw new AccountsConfigError(sourcePath, `${where}.provider must be one of ${Object.keys(PROVIDER_HARNESSES).join(", ")}`);
  }
  if (harness !== PROVIDER_HARNESSES[provider]) {
    throw new AccountsConfigError(sourcePath, `${where}.harness must be "${PROVIDER_HARNESSES[provider]}" for ${provider}`);
  }
  if (typeof keyFile !== "string" || !path.isAbsolute(keyFile)) {
    throw new AccountsConfigError(sourcePath, `${where}.keyFile must be an absolute path`);
  }
  return { name, provider, harness: PROVIDER_HARNESSES[provider], keyFile };
}

function parseProviderAccounts(value: unknown, claudeAccounts: readonly Account[], sourcePath: string): ProviderAccount[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AccountsConfigError(sourcePath, `"providerAccounts" must be a list`);
  const providerAccounts = value.map((item, index) => parseProviderAccount(item, index, sourcePath));
  const names = [...claudeAccounts.map((account) => account.name), ...providerAccounts.map((account) => account.name)];
  const repeatedName = names.find((name, index) => names.indexOf(name) !== index);
  if (repeatedName !== undefined) {
    throw new AccountsConfigError(sourcePath, `account name "${repeatedName}" is listed twice`);
  }
  return providerAccounts;
}

function parseCompanyLogin(value: unknown, sourcePath: string): CompanyLogin {
  if (!isRecord(value)) throw new AccountsConfigError(sourcePath, `"companyLogin" must be an object`);
  refuseUnknownKeys(value, COMPANY_LOGIN_KEYS, "companyLogin", sourcePath);
  const { emailDomain, organizationUuid } = value;
  if (emailDomain === undefined && organizationUuid === undefined) {
    throw new AccountsConfigError(
      sourcePath,
      `"companyLogin" needs an "emailDomain" or an "organizationUuid"`,
    );
  }
  if (emailDomain !== undefined && typeof emailDomain !== "string") {
    throw new AccountsConfigError(sourcePath, `"companyLogin.emailDomain" must be a string`);
  }
  if (organizationUuid !== undefined && typeof organizationUuid !== "string") {
    throw new AccountsConfigError(sourcePath, `"companyLogin.organizationUuid" must be a string`);
  }
  return {
    ...(emailDomain !== undefined ? { emailDomain: emailDomain.toLowerCase() } : {}),
    ...(organizationUuid !== undefined ? { organizationUuid } : {}),
  };
}

function parseFileObject(source: string, sourcePath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new AccountsConfigError(sourcePath, "expected JSON");
  }
  if (!isRecord(value)) throw new AccountsConfigError(sourcePath, "expected an object");
  refuseUnknownKeys(value, ACCOUNTS_CONFIG_KEYS, "the file", sourcePath);
  return value;
}

export function parseAccountsFile(source: string, sourcePath: string): AccountsFile {
  const value = parseFileObject(source, sourcePath);
  if (value.accounts !== undefined || value.providerAccounts === undefined) {
    const config = parseAccountsConfig(source, sourcePath);
    return { config, providerAccounts: config.providerAccounts ?? [] };
  }
  refuseUnknownKeys(value, ["providerAccounts"], "a file with no \"accounts\"", sourcePath);
  const providerAccounts = parseProviderAccounts(value.providerAccounts, [], sourcePath);
  if (providerAccounts.length === 0) {
    throw new AccountsConfigError(sourcePath, `"accounts" must be a non-empty list`);
  }
  return { config: null, providerAccounts };
}

export function parseAccountsConfig(source: string, sourcePath: string): AccountsConfig {
  const value = parseFileObject(source, sourcePath);
  const accounts = parseAccounts(value.accounts, sourcePath);
  const providerAccounts = parseProviderAccounts(value.providerAccounts, accounts, sourcePath);
  const { longRunningAccount, companyLogin, mcpServersAllowedOnEveryAccount, balancing } = value;
  if (
    longRunningAccount !== undefined &&
    !accounts.some((account) => account.name === longRunningAccount)
  ) {
    throw new AccountsConfigError(
      sourcePath,
      `"longRunningAccount" must name a listed account (${accounts.map((account) => account.name).join(", ")})`,
    );
  }
  if (mcpServersAllowedOnEveryAccount !== undefined && !isStringList(mcpServersAllowedOnEveryAccount)) {
    throw new AccountsConfigError(sourcePath, `"mcpServersAllowedOnEveryAccount" must be a list of names`);
  }
  if (balancing !== undefined && typeof balancing !== "boolean") {
    throw new AccountsConfigError(sourcePath, `"balancing" must be true or false`);
  }
  return {
    accounts,
    ...(longRunningAccount !== undefined ? { longRunningAccount: longRunningAccount as string } : {}),
    ...(companyLogin !== undefined ? { companyLogin: parseCompanyLogin(companyLogin, sourcePath) } : {}),
    mcpServersAllowedOnEveryAccount: mcpServersAllowedOnEveryAccount ?? [],
    ...(balancing !== undefined ? { balancing } : {}),
    ...(providerAccounts.length > 0 ? { providerAccounts } : {}),
  };
}

export function readAccountsFile(sourcePath: string = accountsConfigPath()): AccountsFile | null {
  let source: string;
  try {
    source = readFileSync(sourcePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseAccountsFile(source, sourcePath);
}

export function readAccountsConfig(sourcePath: string = accountsConfigPath()): AccountsConfig | null {
  return readAccountsFile(sourcePath)?.config ?? null;
}

export async function writeAccountsConfig(
  config: AccountsConfig | ProviderOnlyAccountsFile,
  targetPath: string = accountsConfigPath(),
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath);
}
