import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { resolveThroneHome } from "../shared-policy/throne-home.ts";
import {
  ACCOUNT_NAME_SHAPE,
  COMPANY_ACCOUNT_WORD,
  PROVIDER_HARNESSES,
  accountsConfigPath,
  isProvider,
  readAccountsFile,
  writeAccountsConfig,
  type ProviderAccount,
} from "./accounts-config.ts";

const ACCOUNTS_FOLDER_NAME = "accounts";
const KEY_FILE_NAME = "api-key";
const PRIVATE_FOLDER_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MODE_BITS = 0o777;
const GROUP_AND_OTHER_BITS = 0o077;
const INDENT = "  ";

export class ProviderAccountRefusal extends Error {
  readonly name = "ProviderAccountRefusal";
}

export interface ProviderAccountPlaces {
  readonly configPath: string;
  readonly throneHome: string;
}

export function realProviderAccountPlaces(): ProviderAccountPlaces {
  return { configPath: accountsConfigPath(), throneHome: resolveThroneHome() };
}

export function providerKeyFilePath(places: ProviderAccountPlaces, provider: keyof typeof PROVIDER_HARNESSES, name: string): string {
  return path.join(places.throneHome, ACCOUNTS_FOLDER_NAME, PROVIDER_HARNESSES[provider], name, KEY_FILE_NAME);
}

export interface ProviderAccountRequest {
  readonly name: string;
  readonly provider: string;
  readonly sourceKeyFile: string;
}

async function readSourceKey(sourceKeyFile: string): Promise<string> {
  let key: string;
  try {
    key = await readFile(sourceKeyFile, "utf8");
  } catch {
    throw new ProviderAccountRefusal(`cannot read the key file ${sourceKeyFile}`);
  }
  if (key.trim() === "") throw new ProviderAccountRefusal(`the key file ${sourceKeyFile} is empty`);
  return key;
}

export async function addProviderAccount(request: ProviderAccountRequest, places: ProviderAccountPlaces): Promise<string[]> {
  const { name, provider, sourceKeyFile } = request;
  if (!isProvider(provider)) {
    throw new ProviderAccountRefusal(`unknown provider "${provider}"; known: ${Object.keys(PROVIDER_HARNESSES).join(", ")}`);
  }
  if (!ACCOUNT_NAME_SHAPE.test(name) || name === COMPANY_ACCOUNT_WORD) {
    throw new ProviderAccountRefusal(`account name must be one plain lowercase word other than "${COMPANY_ACCOUNT_WORD}"`);
  }
  const file = readAccountsFile(places.configPath);
  const takenNames = [
    ...(file?.config?.accounts ?? []).map((account) => account.name),
    ...(file?.providerAccounts ?? []).map((account) => account.name),
  ];
  if (takenNames.includes(name)) throw new ProviderAccountRefusal(`account "${name}" is already registered`);
  const key = await readSourceKey(sourceKeyFile);
  const keyFile = providerKeyFilePath(places, provider, name);
  await mkdir(path.dirname(keyFile), { recursive: true, mode: PRIVATE_FOLDER_MODE });
  await chmod(path.dirname(keyFile), PRIVATE_FOLDER_MODE);
  await writeFile(keyFile, key, { mode: PRIVATE_FILE_MODE });
  await chmod(keyFile, PRIVATE_FILE_MODE);
  const account: ProviderAccount = { name, provider, harness: PROVIDER_HARNESSES[provider], keyFile };
  const providerAccounts = [...(file?.providerAccounts ?? []), account];
  await mkdir(path.dirname(places.configPath), { recursive: true });
  await writeAccountsConfig(
    file?.config ? { ...file.config, providerAccounts } : { providerAccounts },
    places.configPath,
  );
  return [
    `copied the ${provider} key into ${keyFile} (mode 600)`,
    `recorded ${name} (provider ${provider}, harness ${account.harness}) in ${places.configPath}`,
  ];
}

export type ProviderKeyReadiness =
  | { readonly ready: true; readonly account: ProviderAccount; readonly keyFile: string }
  | { readonly ready: false; readonly refusal: string };

function refused(refusal: string): ProviderKeyReadiness {
  return { ready: false, refusal };
}

export async function providerKeyReadiness(
  provider: keyof typeof PROVIDER_HARNESSES,
  configPath: string = accountsConfigPath(),
): Promise<ProviderKeyReadiness> {
  const account = readAccountsFile(configPath)?.providerAccounts.find((candidate) => candidate.provider === provider);
  if (account === undefined) {
    return refused(
      `no ${provider} provider account is configured in ${configPath}; add one with: throne account add <name> --provider ${provider} --key-file <file>`,
    );
  }
  let mode: number;
  let size: number;
  try {
    const details = await stat(account.keyFile);
    mode = details.mode & MODE_BITS;
    size = details.size;
  } catch {
    return refused(`the ${provider} key file ${account.keyFile} of account ${account.name} is missing`);
  }
  if ((mode & GROUP_AND_OTHER_BITS) !== 0) {
    return refused(
      `the ${provider} key file ${account.keyFile} has mode ${mode.toString(8)}, wider than 600; run chmod 600 ${account.keyFile}`,
    );
  }
  if (size === 0 || (await readFile(account.keyFile, "utf8")).trim() === "") {
    return refused(`the ${provider} key file ${account.keyFile} of account ${account.name} is empty`);
  }
  return { ready: true, account, keyFile: account.keyFile };
}

export interface ProviderAccountListDependencies {
  readonly configPath: string;
  readonly listAgents: () => Promise<HerdrAgent[]>;
  readonly readSpawnSpec: (name: string) => Promise<SpawnSpec | null>;
}

function runsOn(spec: SpawnSpec | null, account: ProviderAccount): boolean {
  if (spec === null) return false;
  return spec.account === account.name || (spec.account === undefined && spec.harness === account.harness);
}

export async function listProviderAccounts(dependencies: ProviderAccountListDependencies): Promise<string[]> {
  const providerAccounts = readAccountsFile(dependencies.configPath)?.providerAccounts ?? [];
  if (providerAccounts.length === 0) return [];
  const specs: [string, SpawnSpec | null][] = [];
  for (const agent of await dependencies.listAgents()) {
    if (agent.name !== undefined) specs.push([agent.name, await dependencies.readSpawnSpec(agent.name)]);
  }
  return providerAccounts.flatMap((account) => {
    const agents = specs.filter(([, spec]) => runsOn(spec, account)).map(([name]) => name);
    return [
      `${account.name} — provider ${account.provider}`,
      `${INDENT}harness: ${account.harness}`,
      `${INDENT}key file: ${account.keyFile}`,
      `${INDENT}usage: pay per token`,
      `${INDENT}live agents: ${agents.length === 0 ? "none" : agents.join(", ")}`,
    ];
  });
}
