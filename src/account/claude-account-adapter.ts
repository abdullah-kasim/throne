import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlanUsagePlatformService } from "../plan-usage-remaining/plan-usage-platform.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import type { HttpJsonRequest, HttpJsonResponse } from "../plan-usage-remaining/pipeline.types.ts";
import type { UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import { throneAccountsDirectory } from "../shared-policy/throne-home.ts";
import { ACCOUNT_HARNESSES, isPrimaryAccount, type Account, type CompanyLogin } from "./accounts-config.ts";

const CLAUDE_CONFIG_FILE_NAME = ".claude.json";
const CLAUDE_CREDENTIALS_FILE_NAME = ".credentials.json";

export interface AccountLogin {
  readonly loggedIn: boolean;
  readonly emailDomain?: string;
  readonly organizationUuid?: string;
  readonly isCompany: boolean;
}

export interface ClaudeAccountReadOptions {
  readonly userHome?: string;
  readonly httpJson?: (request: HttpJsonRequest) => Promise<HttpJsonResponse>;
}

export function primaryClaudeConfigFilePath(userHome: string = os.homedir()): string {
  return path.join(userHome, CLAUDE_CONFIG_FILE_NAME);
}

export function claudeAccountConfigFilePath(account: Account, userHome: string = os.homedir()): string {
  return isPrimaryAccount(account, userHome)
    ? primaryClaudeConfigFilePath(userHome)
    : path.join(account.folder, CLAUDE_CONFIG_FILE_NAME);
}

export function claudeAccountsDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = os.homedir(),
): string {
  return path.join(throneAccountsDirectory(environment, userHome), ACCOUNT_HARNESSES.CLAUDE);
}

export function claudeAccountCredentialsPath(account: Account): string {
  return path.join(account.folder, CLAUDE_CREDENTIALS_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOauthAccount(configFilePath: string): Promise<Record<string, unknown> | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configFilePath, "utf8"));
  } catch {
    return undefined;
  }
  return isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : undefined;
}

function emailDomainOf(emailAddress: unknown): string | undefined {
  if (typeof emailAddress !== "string" || !emailAddress.includes("@")) return undefined;
  return emailAddress.slice(emailAddress.lastIndexOf("@") + 1).toLowerCase();
}

function matchesCompanyLogin(
  login: { emailDomain?: string; organizationUuid?: string },
  companyLogin: CompanyLogin | undefined,
): boolean {
  if (companyLogin === undefined) return false;
  return (
    (companyLogin.emailDomain !== undefined && companyLogin.emailDomain === login.emailDomain) ||
    (companyLogin.organizationUuid !== undefined &&
      companyLogin.organizationUuid === login.organizationUuid)
  );
}

async function hasOwnCredentials(account: Account, userHome: string): Promise<boolean> {
  if (isPrimaryAccount(account, userHome)) return true;
  try {
    await access(claudeAccountCredentialsPath(account));
    return true;
  } catch {
    return false;
  }
}

export async function readClaudeAccountLogin(
  account: Account,
  companyLogin: CompanyLogin | undefined,
  options: ClaudeAccountReadOptions = {},
): Promise<AccountLogin> {
  const userHome = options.userHome ?? os.homedir();
  const oauthAccount = await readOauthAccount(claudeAccountConfigFilePath(account, userHome));
  const emailDomain = emailDomainOf(oauthAccount?.emailAddress);
  const organizationUuid =
    typeof oauthAccount?.organizationUuid === "string" ? oauthAccount.organizationUuid : undefined;
  const identity = {
    ...(emailDomain !== undefined ? { emailDomain } : {}),
    ...(organizationUuid !== undefined ? { organizationUuid } : {}),
  };
  const loggedIn =
    (emailDomain !== undefined || organizationUuid !== undefined) && (await hasOwnCredentials(account, userHome));
  return { loggedIn, ...identity, isCompany: loggedIn && matchesCompanyLogin(identity, companyLogin) };
}

export function readClaudeAccountUsage(
  account: Account,
  options: ClaudeAccountReadOptions = {},
): Promise<UsagePayload> {
  const service = isPrimaryAccount(account, options.userHome ?? os.homedir())
    ? realPlanUsageRemainingService()
    : realPlanUsageRemainingService(
        PlanUsagePlatformService.forOtherAccountFolder(claudeAccountCredentialsPath(account), options.httpJson),
      );
  return service.getUsagePayload();
}
