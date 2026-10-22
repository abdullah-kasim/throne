import {
  COMPANY_ACCOUNT_WORD,
  isBalancingOn,
  primaryAccountOf,
  type AccountsConfig,
} from "../../account/accounts-config.ts";
import {
  ACCOUNT_SWITCH_REMAINING_PCT,
  isHarnessUsageUsable,
  type HarnessUsage,
} from "./usage.ts";

export const LONG_RUNNING_ROLES: readonly string[] = ["stager", "regent"];

export type AccountRequirement = typeof COMPANY_ACCOUNT_WORD;

export interface AccountReading {
  readonly name: string;
  readonly loggedIn: boolean;
  readonly isCompany: boolean;
  readonly loginDescription: string;
  readonly usage: HarnessUsage;
}

export interface SpawnAccountRequest {
  readonly role: string;
  readonly explicitAccount?: string;
  readonly requirement?: AccountRequirement;
  readonly config: AccountsConfig;
  readonly readings: readonly AccountReading[];
}

export type SpawnAccountChoice =
  | { kind: "account"; name: string; reason: string }
  | { kind: "pause"; reason: string }
  | { kind: "refuse"; message: string };

const NOT_LOGGED_IN = "not logged in";

export function isLongRunningRole(role: string): boolean {
  return LONG_RUNNING_ROLES.includes(role.trim().toLowerCase());
}

export function accountForLongRunningRoles(config: AccountsConfig): string {
  return config.longRunningAccount ?? config.accounts[0]!.name;
}

function isUnderSwitchThreshold(usage: HarnessUsage): boolean {
  return (
    usage.ok &&
    usage.weeklyPct !== undefined &&
    usage.weeklyPct > ACCOUNT_SWITCH_REMAINING_PCT &&
    (usage.sessionPct === undefined || usage.sessionPct > ACCOUNT_SWITCH_REMAINING_PCT)
  );
}

function isReadable(reading: AccountReading | undefined): reading is AccountReading {
  return reading !== undefined && reading.loggedIn && reading.usage.ok;
}

function describeUsedWindows(usage: HarnessUsage): string {
  const session = usage.sessionPct === undefined ? "5-hour unknown" : `5-hour ${100 - usage.sessionPct}% used`;
  return `${session}, weekly ${100 - (usage.weeklyPct ?? 0)}% used`;
}

function readingsInListOrder(request: SpawnAccountRequest): (AccountReading | undefined)[] {
  return request.config.accounts.map((account) =>
    request.readings.find((reading) => reading.name === account.name),
  );
}

function describeConfiguredAccounts(request: SpawnAccountRequest): string {
  const lines = request.config.accounts.map((account, index) => {
    const reading = readingsInListOrder(request)[index];
    const login = reading?.loggedIn === true ? reading.loginDescription : NOT_LOGGED_IN;
    return `${account.name} (${login})`;
  });
  return `configured accounts: ${lines.join(", ")}`;
}

function unreadableAccountNames(request: SpawnAccountRequest): string[] {
  return request.config.accounts
    .filter((_, index) => !isReadable(readingsInListOrder(request)[index]))
    .map((account) => account.name);
}

function describeUnreadableAccounts(request: SpawnAccountRequest): string {
  const unreadable = unreadableAccountNames(request);
  return unreadable.length === 0 ? "" : `; skipped, no usage reading: ${unreadable.join(", ")}`;
}

function loggedInWithoutUsableReadingPrimaryFirst(request: SpawnAccountRequest): AccountReading[] {
  const primaryName = primaryAccountOf(request.config).name;
  return readingsInListOrder(request)
    .filter((reading): reading is AccountReading => reading?.loggedIn === true && !reading.usage.ok)
    .sort((left, right) => Number(right.name === primaryName) - Number(left.name === primaryName));
}

function describeSpawnWithoutUsableReading(request: SpawnAccountRequest, chosen: AccountReading): string {
  const destination =
    chosen.name === primaryAccountOf(request.config).name ? `the primary account ${chosen.name}` : chosen.name;
  return (
    `no account has a usable usage reading below its limit, so the spawn goes to ${destination}; ` +
    `no usage reading: ${unreadableAccountNames(request).join(", ")}`
  );
}

function chooseCompanyAccount(request: SpawnAccountRequest): SpawnAccountChoice {
  const company = readingsInListOrder(request).find(
    (reading) => reading?.loggedIn === true && reading.isCompany,
  );
  if (company === undefined) {
    return {
      kind: "refuse",
      message: `no configured account is logged in as the company login; ${describeConfiguredAccounts(request)}`,
    };
  }
  if (!company.usage.ok) {
    return {
      kind: "pause",
      reason: `waits for the company account ${company.name}: its usage cannot be read`,
    };
  }
  if (!isHarnessUsageUsable(company.usage)) {
    return {
      kind: "pause",
      reason: `waits for the company account ${company.name}: at its limit (${describeUsedWindows(company.usage)})`,
    };
  }
  return {
    kind: "account",
    name: company.name,
    reason: `company work runs on the company account ${company.name}`,
  };
}

function chooseNamedAccount(request: SpawnAccountRequest, name: string): SpawnAccountChoice {
  if (!request.config.accounts.some((account) => account.name === name)) {
    return {
      kind: "refuse",
      message: `unknown account "${name}"; ${describeConfiguredAccounts(request)}`,
    };
  }
  const reading = request.readings.find((candidate) => candidate.name === name);
  if (reading?.loggedIn !== true) {
    return {
      kind: "refuse",
      message: `account "${name}" is not logged in; ${describeConfiguredAccounts(request)}`,
    };
  }
  return { kind: "account", name, reason: `account ${name} named for this agent` };
}

function chooseAccountByUsage(request: SpawnAccountRequest): SpawnAccountChoice {
  const readable = readingsInListOrder(request).filter(isReadable);
  const unreadableNote = describeUnreadableAccounts(request);
  const underThreshold = readable.find((reading) => isUnderSwitchThreshold(reading.usage));
  if (underThreshold !== undefined) {
    return {
      kind: "account",
      name: underThreshold.name,
      reason:
        `${underThreshold.name} is under ${100 - ACCOUNT_SWITCH_REMAINING_PCT}% used ` +
        `(${describeUsedWindows(underThreshold.usage)})${unreadableNote}`,
    };
  }
  const notAtLimit = readable.find((reading) => isHarnessUsageUsable(reading.usage));
  if (notAtLimit !== undefined) {
    return {
      kind: "account",
      name: notAtLimit.name,
      reason:
        `every readable account is ${100 - ACCOUNT_SWITCH_REMAINING_PCT}% used or more; ` +
        `${notAtLimit.name} is not yet at its limit (${describeUsedWindows(notAtLimit.usage)})${unreadableNote}`,
    };
  }
  const withoutUsableReading = loggedInWithoutUsableReadingPrimaryFirst(request)[0];
  if (withoutUsableReading !== undefined) {
    return {
      kind: "account",
      name: withoutUsableReading.name,
      reason: describeSpawnWithoutUsableReading(request, withoutUsableReading),
    };
  }
  if (readable.length === 0) {
    return { kind: "refuse", message: `no configured account is logged in; ${describeConfiguredAccounts(request)}` };
  }
  return { kind: "pause", reason: "every logged-in account is at its limit" };
}

function choosePrimaryWithBalancingOff(config: AccountsConfig): SpawnAccountChoice {
  const name = primaryAccountOf(config).name;
  return {
    kind: "account",
    name,
    reason: `balancing is off in accounts.json, so the spawn goes to the primary account ${name}`,
  };
}

export function chooseSpawnAccount(request: SpawnAccountRequest): SpawnAccountChoice {
  if (
    request.explicitAccount === COMPANY_ACCOUNT_WORD ||
    request.requirement === COMPANY_ACCOUNT_WORD
  ) {
    return chooseCompanyAccount(request);
  }
  if (request.explicitAccount !== undefined) {
    return chooseNamedAccount(request, request.explicitAccount);
  }
  if (isLongRunningRole(request.role)) {
    const name = accountForLongRunningRoles(request.config);
    return { kind: "account", name, reason: `${request.role} runs on the long-running account ${name}` };
  }
  if (!isBalancingOn(request.config)) return choosePrimaryWithBalancingOff(request.config);
  return chooseAccountByUsage(request);
}
