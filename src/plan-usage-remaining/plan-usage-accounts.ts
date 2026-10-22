import { accountAdapterFor } from "../account/account-adapters.ts";
import {
  accountsConfigPath,
  isPrimaryAccount,
  readAccountsConfig,
  type Account,
  type AccountsConfig,
} from "../account/accounts-config.ts";
import type { ClaudeAccountReadOptions } from "../account/claude-account-adapter.ts";
import type { PlanUsageRemainingService } from "./plan-usage-remaining.service.ts";
import type { PlanUsagePresentationService, UsageCommandResult } from "./plan-usage-presentation.service.ts";
import type { UsagePayload } from "./telemetry.types.ts";

export interface AccountUsage {
  readonly name: string;
  readonly logged_in: boolean;
  readonly usage?: UsagePayload;
}

async function readAccountUsage(
  account: Account,
  config: AccountsConfig,
  primaryPayload: UsagePayload,
  options: ClaudeAccountReadOptions,
): Promise<AccountUsage> {
  const adapter = accountAdapterFor(account);
  const login = await adapter.readLogin(account, config.companyLogin, options);
  if (!login.loggedIn) return { name: account.name, logged_in: false };
  const usage = isPrimaryAccount(account, options.userHome)
    ? primaryPayload
    : await adapter.readUsage(account, options);
  return { name: account.name, logged_in: true, usage };
}

export function readAccountUsages(
  config: AccountsConfig,
  primaryPayload: UsagePayload,
  options: ClaudeAccountReadOptions = {},
): Promise<AccountUsage[]> {
  return Promise.all(
    config.accounts.map((account) => readAccountUsage(account, config, primaryPayload, options)),
  );
}

export async function planUsageCommandResult(
  args: string[],
  usage: PlanUsageRemainingService,
  presentation: PlanUsagePresentationService,
  configPath: string = accountsConfigPath(),
  options: ClaudeAccountReadOptions = {},
): Promise<UsageCommandResult> {
  const payload = await usage.getUsagePayload();
  const config = readAccountsConfig(configPath);
  if (config === null) return presentation.commandResult(args, payload);
  return presentation.accountsCommandResult(args, payload, await readAccountUsages(config, payload, options));
}
