import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { accountForLongRunningRoles } from "../harness-routing/policy/account-balance.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { readAccountUsages, type AccountUsage } from "../plan-usage-remaining/plan-usage-accounts.ts";
import { USAGE_READING_SOURCES, type UsagePayload } from "../plan-usage-remaining/telemetry.types.ts";
import { accountAdapterFor } from "./account-adapters.ts";
import { checkFolderLinks, describeLinkCheck, expectedFolderLinks, LinkState } from "./account-folder-links.ts";
import type { AccountPlaces } from "./account-places.ts";
import {
  isPrimaryAccount,
  primaryClaudeFolder,
  readAccountsConfig,
  type Account,
  type AccountsConfig,
} from "./accounts-config.ts";
import { accountNameOfAgent } from "./agent-account.ts";
import {
  primaryClaudeConfigFilePath,
  type AccountLogin,
  type ClaudeAccountReadOptions,
} from "./claude-account-adapter.ts";
import { mcpServersForAccount, readPrimaryMcpServers, type McpServers } from "./claude-mcp-servers.ts";

const FIVE_HOUR_WINDOW = "5h";
const WEEKLY_WINDOW = "weekly";
const INDENT = "  ";
const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

export interface AccountListDependencies {
  readonly places: AccountPlaces;
  readonly readPrimaryUsage: () => Promise<UsagePayload>;
  readonly listAgents: () => Promise<HerdrAgent[]>;
  readonly readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  readonly readOptions?: ClaudeAccountReadOptions;
  readonly now?: () => Date;
}

function readOptionsOf(dependencies: AccountListDependencies): ClaudeAccountReadOptions {
  return { ...dependencies.readOptions, userHome: dependencies.places.userHome };
}

function describeLogin(login: AccountLogin, config: AccountsConfig): string {
  const identity = [
    login.emailDomain,
    login.organizationUuid === undefined ? undefined : `organisation ${login.organizationUuid}`,
  ].filter((part) => part !== undefined).join(", ");
  const state = login.loggedIn ? `logged in as ${identity}` : `logged out${identity === "" ? "" : ` (last login ${identity})`}`;
  if (config.companyLogin === undefined) return `${state}; no company login is configured`;
  return `${state}; ${login.isCompany ? "the company login" : "not the company login"}`;
}

function usedPercentOf(usage: UsagePayload, capWindow: string): string {
  const window = usage.windows?.find((candidate) => candidate.cap_window === capWindow);
  return window === undefined ? `${capWindow} unknown` : `${capWindow} ${window.used_pct}% used`;
}

function describeReadingAge(usage: UsagePayload, now: Date): string {
  const ageMs = Math.max(0, now.getTime() - Date.parse(usage.as_of));
  return ageMs < MINUTE_MS ? `${Math.floor(ageMs / SECOND_MS)} s` : `${Math.floor(ageMs / MINUTE_MS)} min`;
}

function describeUsage(accountUsage: AccountUsage | undefined, now: Date): string {
  const usage = accountUsage?.usage;
  if (usage === undefined) return "no reading (logged out)";
  if (usage.source === "error") return `unreadable — ${usage.error}`;
  const source = usage.reading_source ?? USAGE_READING_SOURCES.FRESH;
  return `${usedPercentOf(usage, FIVE_HOUR_WINDOW)}, ${usedPercentOf(usage, WEEKLY_WINDOW)} (read ${describeReadingAge(usage, now)} ago, ${source})`;
}

async function liveAgentNamesByAccount(
  config: AccountsConfig,
  dependencies: AccountListDependencies,
): Promise<Map<string, string[]>> {
  const byAccount = new Map<string, string[]>();
  for (const agent of await dependencies.listAgents()) {
    if (agent.name === undefined) continue;
    const accountName = accountNameOfAgent(await dependencies.readSpawnSpec(agent.name), config, dependencies.places.userHome);
    byAccount.set(accountName, [...(byAccount.get(accountName) ?? []), agent.name]);
  }
  return byAccount;
}

function listOrNone(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

async function describeLinkDrift(account: Account, userHome: string): Promise<string> {
  const checks = await checkFolderLinks(account.folder, await expectedFolderLinks(primaryClaudeFolder(userHome)));
  const drift = checks.filter((check) => check.state !== LinkState.Correct);
  return drift.length === 0 ? "links: all in place" : `link drift: ${drift.map(describeLinkCheck).join("; ")}`;
}

async function describeAccount(
  account: Account,
  config: AccountsConfig,
  accountUsage: AccountUsage | undefined,
  liveAgents: readonly string[],
  primaryServers: McpServers,
  dependencies: AccountListDependencies,
): Promise<string[]> {
  const { userHome } = dependencies.places;
  const login = await accountAdapterFor(account).readLogin(account, config.companyLogin, readOptionsOf(dependencies));
  const serversAtLaunch = Object.keys(mcpServersForAccount(primaryServers, login.isCompany, config.mcpServersAllowedOnEveryAccount));
  const deniedServers = Object.keys(primaryServers).filter((server) => !serversAtLaunch.includes(server));
  const lines = [
    `${account.name} — ${account.folder}`,
    `${INDENT}login: ${describeLogin(login, config)}`,
    `${INDENT}usage: ${describeUsage(accountUsage, (dependencies.now ?? (() => new Date()))())}`,
    `${INDENT}live agents: ${listOrNone(liveAgents)}`,
    `${INDENT}MCP servers at launch: ${listOrNone(serversAtLaunch)}; denied: ${listOrNone(deniedServers)}`,
  ];
  lines.push(`${INDENT}claude.ai connectors: ${login.isCompany ? "on" : "switched off"} at launch`);
  if (!isPrimaryAccount(account, userHome)) lines.push(`${INDENT}${await describeLinkDrift(account, userHome)}`);
  return lines;
}

export function noAccountsLine(places: AccountPlaces): string {
  return `No accounts are configured (${places.configPath} is absent); the throne runs every agent on ${primaryClaudeFolder(places.userHome)}.`;
}

export async function listAccounts(dependencies: AccountListDependencies): Promise<string[]> {
  const { places } = dependencies;
  const config = readAccountsConfig(places.configPath);
  if (config === null) return [noAccountsLine(places)];
  const usages = await readAccountUsages(config, await dependencies.readPrimaryUsage(), readOptionsOf(dependencies));
  const liveAgents = await liveAgentNamesByAccount(config, dependencies);
  const primaryServers = await readPrimaryMcpServers(primaryClaudeConfigFilePath(places.userHome));
  const lines: string[] = [];
  for (const account of config.accounts) {
    const accountUsage = usages.find((usage) => usage.name === account.name);
    lines.push(
      ...(await describeAccount(account, config, accountUsage, liveAgents.get(account.name) ?? [], primaryServers, dependencies)),
    );
  }
  lines.push(`long-running account (Stagers and the Regent): ${accountForLongRunningRoles(config)}`);
  return lines;
}
