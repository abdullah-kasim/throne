import os from "node:os";
import path from "node:path";
import { IdentityLineReadStatus, readAgentRole } from "../agentdata/identity-data.service.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { accountForLongRunningRoles, isLongRunningRole } from "../harness-routing/policy/account-balance.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import {
  primaryAccountOf,
  primaryClaudeFolder,
  readAccountsConfig,
  type Account,
  type AccountsConfig,
} from "./accounts-config.ts";

const CLAUDE_PROJECTS_FOLDER_NAME = "projects";

export interface LaunchAccountOption {
  account?: string;
}

export type ReadAccountsConfig = () => AccountsConfig | null;

export type ReadAgentRole = (name: string) => Promise<string | undefined>;

export async function readRecordedAgentRole(name: string): Promise<string | undefined> {
  const role = await readAgentRole(name);
  return role.status === IdentityLineReadStatus.Found ? role.value : undefined;
}

export async function isLongRunningAgent(name: string, readRole: ReadAgentRole): Promise<boolean> {
  if (sameAgentName(name, REGENT_NAME)) return true;
  const role = await readRole(name);
  return role !== undefined && isLongRunningRole(role);
}

export function accountNameOfAgent(spec: SpawnSpec | null, config: AccountsConfig, userHome: string): string {
  return spec?.account ?? primaryAccountOf(config, userHome).name;
}

export function findAccount(config: AccountsConfig, name: string): Account | undefined {
  return config.accounts.find((account) => account.name === name);
}

export function configuredAccountNames(config: AccountsConfig): string {
  return config.accounts.map((account) => account.name).join(", ");
}

export async function accountOfAgentWithNoRecord(
  name: string,
  config: AccountsConfig,
  readRole: ReadAgentRole,
  userHome: string,
): Promise<string> {
  return (await isLongRunningAgent(name, readRole))
    ? accountForLongRunningRoles(config)
    : primaryAccountOf(config, userHome).name;
}

export async function launchAccountOption(
  name: string,
  recordedAccount: string | undefined,
  readConfig: ReadAccountsConfig = readAccountsConfig,
  readRole: ReadAgentRole = readRecordedAgentRole,
  userHome: string = os.homedir(),
): Promise<LaunchAccountOption> {
  const config = readConfig();
  if (config === null) return {};
  return { account: recordedAccount ?? (await accountOfAgentWithNoRecord(name, config, readRole, userHome)) };
}

export function longRunningLaunchAccountOption(readConfig: ReadAccountsConfig): LaunchAccountOption {
  const config = readConfig();
  return config === null ? {} : { account: accountForLongRunningRoles(config) };
}

function recordedAccountFolder(
  recordedAccount: string | undefined,
  readConfig: ReadAccountsConfig,
): string | undefined {
  if (recordedAccount === undefined) return undefined;
  const config = readConfig();
  return config === null ? undefined : findAccount(config, recordedAccount)?.folder;
}

export function claudeProjectsFolderOf(
  recordedAccount: string | undefined,
  readConfig: ReadAccountsConfig = readAccountsConfig,
  userHome: string = os.homedir(),
): string {
  const folder = recordedAccountFolder(recordedAccount, readConfig) ?? primaryClaudeFolder(userHome);
  return path.join(folder, CLAUDE_PROJECTS_FOLDER_NAME);
}
