import type { AccountReading } from "../harness-routing/policy/account-balance.ts";
import { readHarnessUsage } from "../harness-routing/policy/usage.ts";
import type { UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import {
  ACCOUNT_HARNESSES,
  type Account,
  type AccountHarness,
  type AccountsConfig,
  type CompanyLogin,
} from "./accounts-config.ts";
import {
  readClaudeAccountLogin,
  readClaudeAccountUsage,
  type AccountLogin,
  type ClaudeAccountReadOptions,
} from "./claude-account-adapter.ts";

export interface AccountAdapter {
  readLogin(account: Account, companyLogin: CompanyLogin | undefined, options?: ClaudeAccountReadOptions): Promise<AccountLogin>;
  readUsage(account: Account, options?: ClaudeAccountReadOptions): Promise<UsagePayload>;
}

const ACCOUNT_ADAPTERS: Readonly<Record<AccountHarness, AccountAdapter>> = {
  [ACCOUNT_HARNESSES.CLAUDE]: {
    readLogin: readClaudeAccountLogin,
    readUsage: readClaudeAccountUsage,
  },
};

export function accountAdapterFor(account: Account): AccountAdapter {
  return ACCOUNT_ADAPTERS[account.harness];
}

export function describeLogin(login: AccountLogin): string {
  return login.emailDomain ?? login.organizationUuid ?? "logged in";
}

export async function readAccountReading(
  account: Account,
  config: AccountsConfig,
  options: ClaudeAccountReadOptions = {},
): Promise<AccountReading> {
  const adapter = accountAdapterFor(account);
  const login = await adapter.readLogin(account, config.companyLogin, options);
  const usage = login.loggedIn ? readHarnessUsage(await adapter.readUsage(account, options)) : { ok: false };
  return {
    name: account.name,
    loggedIn: login.loggedIn,
    isCompany: login.isCompany,
    loginDescription: describeLogin(login),
    usage,
  };
}
