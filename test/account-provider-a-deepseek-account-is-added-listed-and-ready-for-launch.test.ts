import assert from "node:assert/strict";
import { chmod, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { SpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import type { HerdrAgent } from "../src/herdr/herdr-identity-contracts.ts";
import { addProviderAccount, listProviderAccounts, providerKeyReadiness } from "../src/account/provider-accounts.ts";
import { listAccounts } from "../src/account/account-list.ts";
import { addAccount } from "../src/account/account-add.ts";
import { readAccountsConfig } from "../src/account/accounts-config.ts";
import { makeAccountHomes, primaryUsageReader, usageEndpoint, type AccountHomes } from "../src/account/account-homes.test-support.ts";

const DUMMY_KEY = "dummy-deepseek-key-for-tests";

function piAgent(name: string): HerdrAgent {
  return { agent: "pi", name, agentStatus: "idle", cwd: "/work", focused: false, paneId: `pane-${name}`, tabId: `tab-${name}`, terminalId: `terminal-${name}` };
}

const PI_SPEC: SpawnSpec = { harness: "pi", model: "flash", effort: 2, cwd: "/work", spawned_at: "2026-11-15T00:00:00Z", account: "deepseek" };

function providerPlaces(homes: AccountHomes) {
  return { configPath: homes.places.configPath, throneHome: path.join(homes.places.userHome, "throne-home") };
}

async function addDeepseek(homes: AccountHomes): Promise<string[]> {
  const sourceKeyFile = path.join(homes.places.userHome, ".deepseek-api-key");
  await writeFile(sourceKeyFile, `${DUMMY_KEY}\n`);
  return addProviderAccount({ name: "deepseek", provider: "deepseek", sourceKeyFile }, providerPlaces(homes));
}

function claudeListLines(homes: AccountHomes) {
  return listAccounts({
    places: homes.places,
    readPrimaryUsage: primaryUsageReader(),
    listAgents: async () => [],
    readSpawnSpec: async () => null,
    readOptions: { httpJson: usageEndpoint().httpJson },
  }).then((lines) => lines.map((line) => line.replace(/\(read \d+ (?:s|min) ago, /, "(").replace(/\((?:fresh|cached)\)/, "(reading)")));
}

test("P3.1 account add creates a deepseek provider account that account list shows with pay per token and its agents, never the key", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  const addLines = await addDeepseek(homes);
  const lines = await listProviderAccounts({
    configPath: homes.places.configPath,
    listAgents: async () => [piAgent("shadow-pi")],
    readSpawnSpec: async () => PI_SPEC,
  });
  const keyFile = path.join(homes.places.userHome, "throne-home", "accounts", "pi", "deepseek", "api-key");
  assert.deepEqual(lines, [
    "deepseek — provider deepseek",
    "  harness: pi",
    `  key file: ${keyFile}`,
    "  usage: pay per token",
    "  live agents: shadow-pi",
  ]);
  assert.equal([...addLines, ...lines].some((line) => line.includes(DUMMY_KEY)), false);
});

test("P3.3 the key file sits under the account folder in the throne home with mode 600 and a wider mode is refused naming the file", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  await addDeepseek(homes);
  const ready = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(ready.ready, true);
  if (!ready.ready) return;
  assert.ok(ready.keyFile.startsWith(path.join(homes.places.userHome, "throne-home", "accounts")));
  assert.equal((await stat(ready.keyFile)).mode & 0o777, 0o600);
  assert.equal(await readFile(ready.keyFile, "utf8"), `${DUMMY_KEY}\n`);
  await chmod(ready.keyFile, 0o644);
  const widened = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(widened.ready, false);
  if (widened.ready) return;
  assert.match(widened.refusal, /mode 644, wider than 600/);
  assert.ok(widened.refusal.includes(ready.keyFile));
});

test("P3.4 the claude account rows are the same before and after the first provider account is added", async () => {
  const withoutFile = await makeAccountHomes({ writeAccountsFile: false });
  const beforeAbsent = await claudeListLines(withoutFile);
  await addDeepseek(withoutFile);
  assert.deepEqual(await claudeListLines(withoutFile), beforeAbsent);
  assert.equal(readAccountsConfig(withoutFile.places.configPath), null);

  const withFile = await makeAccountHomes();
  const beforePresent = await claudeListLines(withFile);
  await addDeepseek(withFile);
  assert.deepEqual(await claudeListLines(withFile), beforePresent);
});

test("P3.1 account list with only a provider account says no Claude accounts are configured, not that the accounts file is absent", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  await addDeepseek(homes);
  const lines = await claudeListLines(homes);
  assert.deepEqual(lines, [`No Claude accounts are configured in ${homes.places.configPath}; the throne runs every Claude agent on ${homes.primaryFolder}.`]);
  assert.equal(lines.some((line) => line.includes("absent")), false);
});

test("P3.4 adding a claude account after a provider account keeps the provider account", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  await addDeepseek(homes);
  await addAccount("tertiary", { places: homes.places, claudeBinary: "/bin/false" });
  const ready = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(ready.ready, true);
  assert.deepEqual(readAccountsConfig(homes.places.configPath)?.accounts.map((account) => account.name), ["primary", "tertiary"]);
});

test("P3.5 a missing account, a missing key file or an empty key file refuses the pi launch naming what is missing", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  const noAccount = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(noAccount.ready, false);
  if (!noAccount.ready) assert.match(noAccount.refusal, /no deepseek provider account is configured/);
  await addDeepseek(homes);
  const keyFile = path.join(homes.places.userHome, "throne-home", "accounts", "pi", "deepseek", "api-key");
  await writeFile(keyFile, "");
  const empty = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(empty.ready, false);
  if (!empty.ready) assert.equal(empty.refusal, `the deepseek key file ${keyFile} of account deepseek is empty`);
  await unlink(keyFile);
  const missing = await providerKeyReadiness("deepseek", homes.places.configPath);
  assert.equal(missing.ready, false);
  if (!missing.ready) assert.equal(missing.refusal, `the deepseek key file ${keyFile} of account deepseek is missing`);
});
