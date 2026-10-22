import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import { accountForLongRunningRoles } from "../harness-routing/policy/account-balance.ts";
import {
  AccountsConfigError,
  accountsConfigPath,
  isBalancingOn,
  isPrimaryAccount,
  readAccountsConfig,
  writeAccountsConfig,
} from "./accounts-config.ts";

const TWO_ACCOUNTS = {
  accounts: [
    { name: "primary", harness: "claude", folder: "/Users/theuser/.claude" },
    { name: "secondary", harness: "claude", folder: "/Users/theuser/accounts/secondary" },
  ],
  companyLogin: { emailDomain: "Example.com" },
  mcpServersAllowedOnEveryAccount: ["notes"],
};

test("without an accounts file no account is configured", async () => {
  const throneHome = await makeScratchDirectory("accounts-config-absent-");
  const configPath = accountsConfigPath({ THRONE_DATA_HOME: throneHome });
  assert.equal(configPath, path.join(throneHome, "config", "accounts.json"));
  assert.equal(readAccountsConfig(configPath), null);
});

test("the accounts file keeps its list order, long-running account, company login and shared servers", async () => {
  const throneHome = await makeScratchDirectory("accounts-config-read-");
  const configPath = accountsConfigPath({ THRONE_DATA_HOME: throneHome });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(TWO_ACCOUNTS));
  const config = readAccountsConfig(configPath)!;
  assert.deepEqual(config.accounts.map((account) => account.name), ["primary", "secondary"]);
  assert.equal(accountForLongRunningRoles(config), "primary");
  assert.deepEqual(config.companyLogin, { emailDomain: "example.com" });
  assert.deepEqual(config.mcpServersAllowedOnEveryAccount, ["notes"]);

  await writeAccountsConfig({ ...config, longRunningAccount: "secondary" }, configPath);
  const rewritten = readAccountsConfig(configPath)!;
  assert.equal(accountForLongRunningRoles(rewritten), "secondary");
  assert.match(await readFile(configPath, "utf8"), /"longRunningAccount": "secondary"/);
});

test("a malformed accounts file is refused", async () => {
  const throneHome = await makeScratchDirectory("accounts-config-malformed-");
  const configPath = path.join(throneHome, "accounts.json");
  const malformed = [
    "{ not json",
    JSON.stringify({ ...TWO_ACCOUNTS, unexpected: true }),
    JSON.stringify({ accounts: [] }),
    JSON.stringify({ accounts: [{ name: "primary", harness: "claude", folder: "relative/folder" }] }),
    JSON.stringify({ accounts: [{ name: "company", harness: "claude", folder: "/a" }] }),
    JSON.stringify({ accounts: [{ name: "primary", harness: "codex", folder: "/a" }] }),
    JSON.stringify({ ...TWO_ACCOUNTS, accounts: [TWO_ACCOUNTS.accounts[0], TWO_ACCOUNTS.accounts[0]] }),
    JSON.stringify({ ...TWO_ACCOUNTS, longRunningAccount: "tertiary" }),
    JSON.stringify({ ...TWO_ACCOUNTS, companyLogin: {} }),
    JSON.stringify({ ...TWO_ACCOUNTS, balancing: "off" }),
  ];
  for (const source of malformed) {
    await writeFile(configPath, source);
    assert.throws(() => readAccountsConfig(configPath), AccountsConfigError, source);
  }
});

test("the primary account is the one whose folder is the home Claude folder, however it is spelled", async () => {
  const userHome = await makeScratchDirectory("accounts-config-home-");
  await mkdir(path.join(userHome, ".claude"));
  await symlink(path.join(userHome, ".claude"), path.join(userHome, "claude-link"));
  const primary = { name: "primary", harness: "claude", folder: path.join(userHome, "claude-link") } as const;
  const secondary = { name: "secondary", harness: "claude", folder: path.join(userHome, "secondary") } as const;
  assert.equal(isPrimaryAccount(primary, userHome), true);
  assert.equal(isPrimaryAccount(secondary, userHome), false);
});

test('accounts.json accepts "balancing": false', async () => {
  const throneHome = await makeScratchDirectory("accounts-config-balancing-off-");
  const configPath = path.join(throneHome, "accounts.json");
  await writeFile(configPath, JSON.stringify({ ...TWO_ACCOUNTS, balancing: false }));
  const config = readAccountsConfig(configPath)!;
  assert.equal(isBalancingOn(config), false);
  assert.deepEqual(config.accounts.map((account) => account.folder), TWO_ACCOUNTS.accounts.map((account) => account.folder));
  await writeFile(configPath, JSON.stringify(TWO_ACCOUNTS));
  assert.equal(isBalancingOn(readAccountsConfig(configPath)!), true);
});

test('accounts.json refuses a "balancing" value that is not true or false', async () => {
  const throneHome = await makeScratchDirectory("accounts-config-balancing-bad-");
  const configPath = path.join(throneHome, "accounts.json");
  for (const balancing of ["false", 0, null, {}]) {
    await writeFile(configPath, JSON.stringify({ ...TWO_ACCOUNTS, balancing }));
    assert.throws(() => readAccountsConfig(configPath), /"balancing" must be true or false/, String(balancing));
  }
});
