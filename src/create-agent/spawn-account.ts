import { readAccountReading, accountAdapterFor, describeLogin } from "../account/account-adapters.ts";
import {
  COMPANY_ACCOUNT_WORD,
  isBalancingOn,
  isPrimaryAccount,
  readAccountsConfig,
  type Account,
  type AccountsConfig,
} from "../account/accounts-config.ts";
import { HARNESS_NAMES, type Harness } from "../harness-routing/harness.ts";
import {
  chooseSpawnAccount,
  type AccountReading,
  type AccountRequirement,
} from "../harness-routing/policy/account-balance.ts";
import type { ObjectiveContract } from "../shared-policy/objective-contract.ts";
import { stderrWriter } from "./command-context.ts";
import type { CreateAgentDeps, RegistrationResolution, StageResult } from "./create.types.ts";
import type { NativeClaudeUsageReader } from "./native-availability.ts";

export interface SpawnAccount {
  readonly account?: Account;
  readonly requirement?: AccountRequirement;
  readonly reason?: string;
}

const NOTHING_LAUNCHED = "No registration, tab, or harness launch was created.";
const RECORDED_ACCOUNT_REASON = "recorded at spawn";
const NO_ACCOUNT: SpawnAccount = {};
const USAGE_NOT_READ = { ok: false } as const;

function takesAnAccount(harness: Harness): boolean {
  return harness === HARNESS_NAMES.CLAUDE;
}

function configuredAccountNames(config: AccountsConfig): string {
  return config.accounts.map((account) => account.name).join(", ");
}

function accountNamed(config: AccountsConfig, name: string | undefined): Account | undefined {
  return config.accounts.find((account) => account.name === name);
}

async function inheritedAccountRequirement(
  request: RegistrationResolution,
  objectiveContract: ObjectiveContract | undefined,
  deps: CreateAgentDeps,
): Promise<AccountRequirement | undefined> {
  if (objectiveContract?.kind !== "campaign" || request.role.trim().toLowerCase() !== "shadow") {
    return undefined;
  }
  const supervisor = await deps.readSpawnSpec(request.flags.supervisor as string);
  return supervisor?.account_requirement;
}

function readConfig(deps: CreateAgentDeps): AccountsConfig | null {
  return (deps.readAccountsConfig ?? readAccountsConfig)();
}

function readReadings(config: AccountsConfig, deps: CreateAgentDeps): Promise<AccountReading[]> {
  const readReading = deps.readAccountReading ?? readAccountReading;
  return Promise.all(config.accounts.map((account) => readReading(account, config)));
}

function readLoginsWithoutUsage(config: AccountsConfig, deps: CreateAgentDeps): Promise<AccountReading[]> {
  const readLogin =
    deps.readAccountLogin ??
    ((account: Account, companyLogin: AccountsConfig["companyLogin"]) =>
      accountAdapterFor(account).readLogin(account, companyLogin));
  return Promise.all(
    config.accounts.map(async (account) => {
      const login = await readLogin(account, config.companyLogin);
      return {
        name: account.name,
        loggedIn: login.loggedIn,
        isCompany: login.isCompany,
        loginDescription: describeLogin(login),
        usage: USAGE_NOT_READ,
      };
    }),
  );
}

function readReadingsTheChoiceNeeds(
  config: AccountsConfig,
  explicitAccount: string | undefined,
  requirement: AccountRequirement | undefined,
  deps: CreateAgentDeps,
): Promise<AccountReading[]> {
  if (isBalancingOn(config) || requirement !== undefined) return readReadings(config, deps);
  if (explicitAccount !== undefined) return readLoginsWithoutUsage(config, deps);
  return Promise.resolve([]);
}

function refuse(request: RegistrationResolution, deps: CreateAgentDeps, message: string): StageResult<SpawnAccount> {
  stderrWriter(deps)(`create-agent: refusing "${request.name}" — ${message}. ${NOTHING_LAUNCHED}\n`);
  return { ok: false, code: 1 };
}

function recordedAccount(
  request: RegistrationResolution,
  config: AccountsConfig,
  deps: CreateAgentDeps,
): StageResult<SpawnAccount> {
  if (request.account === undefined) return { ok: true, value: NO_ACCOUNT };
  const account = accountNamed(config, request.account);
  if (account === undefined) {
    return refuse(
      request,
      deps,
      `its recorded account "${request.account}" is not configured; configured accounts: ${configuredAccountNames(config)}`,
    );
  }
  return {
    ok: true,
    value: { account, requirement: request.accountRequirement, reason: RECORDED_ACCOUNT_REASON },
  };
}

export async function resolveSpawnAccount(
  request: RegistrationResolution,
  objectiveContract: ObjectiveContract | undefined,
  deps: CreateAgentDeps,
): Promise<StageResult<SpawnAccount>> {
  const explicitAccount = request.flags.account;
  if (!takesAnAccount(request.launchHarness)) {
    return explicitAccount === undefined
      ? { ok: true, value: NO_ACCOUNT }
      : refuse(request, deps, `--account applies to Claude agents only, not ${request.launchHarness}`);
  }
  let config: AccountsConfig | null;
  try {
    config = readConfig(deps);
  } catch (error) {
    return refuse(request, deps, error instanceof Error ? error.message : String(error));
  }
  if (config === null) {
    return explicitAccount === undefined
      ? { ok: true, value: NO_ACCOUNT }
      : refuse(request, deps, `--account ${explicitAccount} was given but no accounts are configured`);
  }
  if (request.resuming) return recordedAccount(request, config, deps);
  const requirement =
    explicitAccount === COMPANY_ACCOUNT_WORD
      ? COMPANY_ACCOUNT_WORD
      : await inheritedAccountRequirement(request, objectiveContract, deps);
  if (requirement !== undefined && explicitAccount !== undefined && explicitAccount !== COMPANY_ACCOUNT_WORD) {
    return refuse(
      request,
      deps,
      `its campaign runs on the company account only, so --account ${explicitAccount} cannot be used`,
    );
  }
  const choice = chooseSpawnAccount({
    role: request.role,
    explicitAccount,
    requirement,
    config,
    readings: await readReadingsTheChoiceNeeds(config, explicitAccount, requirement, deps),
  });
  if (choice.kind === "refuse") return refuse(request, deps, choice.message);
  if (choice.kind === "pause") return refuse(request, deps, `the spawn is paused: ${choice.reason}`);
  return { ok: true, value: { account: accountNamed(config, choice.name), requirement, reason: choice.reason } };
}

export function accountUsageReader(
  spawnAccount: SpawnAccount,
  deps: CreateAgentDeps,
): NativeClaudeUsageReader | undefined {
  const account = spawnAccount.account;
  if (account === undefined || isPrimaryAccount(account)) return undefined;
  const readUsage = deps.readAccountUsage ?? ((other: Account) => accountAdapterFor(other).readUsage(other));
  return () => readUsage(account);
}
