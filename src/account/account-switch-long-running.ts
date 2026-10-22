import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { sameAgentName, type HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import type { RestartOutcome } from "../restart-harnesses/restart-harnesses-runtime.ts";
import { claudeProjectDirectory } from "../session/runtime-model-acceptance.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { accountAdapterFor } from "./account-adapters.ts";
import type { AccountPlaces } from "./account-places.ts";
import { readAccountsConfig, writeAccountsConfig, type Account, type AccountsConfig } from "./accounts-config.ts";
import {
  accountNameOfAgent,
  configuredAccountNames,
  findAccount,
  isLongRunningAgent,
  type ReadAgentRole,
} from "./agent-account.ts";
import type { ClaudeAccountReadOptions } from "./claude-account-adapter.ts";

const PROJECTS_FOLDER_NAME = "projects";
const TRANSCRIPT_EXTENSION = ".jsonl";
const COMMAND_PREFIX = "account switch-long-running:";

export class AccountSwitchRefusal extends Error {
  readonly name = "AccountSwitchRefusal";
}

export interface AccountSwitchDependencies {
  readonly places: AccountPlaces;
  readonly listAgents: () => Promise<HerdrAgent[]>;
  readonly readRole: ReadAgentRole;
  readonly readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
  readonly writeSpawnSpec: (name: string, spec: SpawnSpec) => Promise<void>;
  readonly recordAccountInIdentity: (name: string, account: string) => Promise<void>;
  readonly restartInPlace: (names: readonly string[]) => Promise<RestartOutcome[]>;
  readonly readOptions?: ClaudeAccountReadOptions;
}

export interface AccountSwitchResult {
  readonly lines: string[];
  readonly failed: boolean;
}

interface AgentMove {
  readonly agent: HerdrAgent & { name: string };
  readonly spec: SpawnSpec | null;
  readonly from: Account;
}

async function targetAccountOrRefusal(
  config: AccountsConfig,
  name: string,
  dependencies: AccountSwitchDependencies,
): Promise<Account> {
  const target = findAccount(config, name);
  if (target === undefined) {
    throw new AccountSwitchRefusal(`unknown account "${name}"; the configured accounts are ${configuredAccountNames(config)}`);
  }
  const login = await accountAdapterFor(target).readLogin(target, config.companyLogin, {
    ...dependencies.readOptions,
    userHome: dependencies.places.userHome,
  });
  if (!login.loggedIn) {
    throw new AccountSwitchRefusal(`account "${name}" is logged out; the configured accounts are ${configuredAccountNames(config)}`);
  }
  return target;
}

function projectsFolderOf(account: Account): string {
  return path.join(account.folder, PROJECTS_FOLDER_NAME);
}

export async function copySessionToAccount(cwd: string, sessionId: string, from: Account, to: Account): Promise<void> {
  const sourceFolder = claudeProjectDirectory(cwd, projectsFolderOf(from));
  const targetFolder = claudeProjectDirectory(cwd, projectsFolderOf(to));
  await mkdir(targetFolder, { recursive: true });
  await cp(path.join(sourceFolder, `${sessionId}${TRANSCRIPT_EXTENSION}`), path.join(targetFolder, `${sessionId}${TRANSCRIPT_EXTENSION}`));
  await cp(path.join(sourceFolder, sessionId), path.join(targetFolder, sessionId), { recursive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function moveAgentRecord(move: AgentMove, target: Account, dependencies: AccountSwitchDependencies): Promise<void> {
  if (move.agent.sessionId === undefined) throw new Error("herdr reports no native session id to carry across");
  await copySessionToAccount(move.agent.cwd, move.agent.sessionId, move.from, target);
  if (move.spec !== null) await dependencies.writeSpawnSpec(move.agent.name, { ...move.spec, account: target.name });
  await dependencies.recordAccountInIdentity(move.agent.name, target.name);
}

function restartLine(outcome: RestartOutcome | undefined, name: string, target: Account): string {
  if (outcome === undefined) return `${COMMAND_PREFIX} failed    ${name} — restart-harnesses reported nothing for it`;
  if (outcome.verdict === "restarted") return `${COMMAND_PREFIX} moved     ${name} to ${target.name} — ${outcome.detail}`;
  return `${COMMAND_PREFIX} ${outcome.verdict.padEnd(9)} ${name} — recorded on ${target.name}, but the restart did not happen: ${outcome.detail}`;
}

export async function switchLongRunningAccount(
  name: string,
  dependencies: AccountSwitchDependencies,
): Promise<AccountSwitchResult> {
  const { places } = dependencies;
  const config = readAccountsConfig(places.configPath);
  if (config === null) throw new AccountSwitchRefusal(`no accounts are configured (${places.configPath} is absent)`);
  const target = await targetAccountOrRefusal(config, name, dependencies);
  await writeAccountsConfig({ ...config, longRunningAccount: target.name }, places.configPath);
  const lines = [`${COMMAND_PREFIX} Stagers and the Regent now start on ${target.name}`];
  let failed = false;
  const moved: string[] = [];
  for (const agent of await dependencies.listAgents()) {
    const agentName = agent.name;
    if (agentName === undefined || agent.agent !== target.harness) continue;
    if (!(await isLongRunningAgent(agentName, dependencies.readRole))) continue;
    const spec = await dependencies.readSpawnSpec(agentName);
    const fromName = accountNameOfAgent(spec, config, places.userHome);
    const from = findAccount(config, fromName);
    if (from === undefined) {
      lines.push(`${COMMAND_PREFIX} failed    ${agentName} — its recorded account "${fromName}" is not configured; left running`);
      failed = true;
      continue;
    }
    if (from.name === target.name) {
      lines.push(`${COMMAND_PREFIX} unchanged ${agentName} — already on ${target.name}`);
      continue;
    }
    try {
      await moveAgentRecord({ agent: { ...agent, name: agentName }, spec, from }, target, dependencies);
      moved.push(agentName);
    } catch (error) {
      lines.push(`${COMMAND_PREFIX} failed    ${agentName} — ${errorText(error)}; left running on ${from.name}`);
      failed = true;
    }
  }
  if (moved.length === 0) return { lines, failed };
  const outcomes = await dependencies.restartInPlace(moved);
  for (const agentName of moved) {
    const outcome = outcomes.find((candidate) => sameAgentName(candidate.name, agentName));
    if (outcome?.verdict !== "restarted") failed = true;
    lines.push(restartLine(outcome, agentName, target));
  }
  return { lines, failed };
}
