import assert from "node:assert/strict";
import { readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { addAccount } from "./account-add.ts";
import { makeAccountHomes } from "./account-homes.test-support.ts";
import { readAccountsConfig } from "./accounts-config.ts";

const CLAUDE_BINARY = "/pinned/claude";
const ACCESS_MODE_BITS = 0o777;

test("account add sets up a folder with links to the primary's shared files and prints the login command", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  const lines = await addAccount("spare", { places: homes.places, claudeBinary: CLAUDE_BINARY });
  const folder = path.join(homes.places.accountsFolder, "spare");

  assert.equal((await stat(folder)).mode & ACCESS_MODE_BITS, 0o700);
  for (const name of ["CLAUDE.md", "skills", "hooks"]) {
    assert.equal(await readlink(path.join(folder, name)), path.join(homes.primaryFolder, name));
  }
  assert.equal(await readlink(path.join(folder, "settings.json")), homes.settingsTarget);
  const standIn = path.join(homes.places.accountsFolder, "bin", "security");
  assert.equal(await readFile(standIn, "utf8"), await readFile(homes.places.repositoryStandInPath, "utf8"));
  assert.equal((await stat(standIn)).mode & ACCESS_MODE_BITS, 0o755);
  assert.deepEqual(
    readAccountsConfig(homes.places.configPath)?.accounts.map((account) => [account.name, account.folder]),
    [["primary", homes.primaryFolder], ["spare", folder]],
  );
  assert.deepEqual(lines.slice(-3), [
    "To log spare in, run:",
    `  env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CONFIG_DIR=${folder} PATH="${path.dirname(standIn)}:$PATH" DISABLE_AUTOUPDATER=1 ${CLAUDE_BINARY}`,
    "then type /login, sign in, then /exit.",
  ]);
});

test("account add never copies a credential or the primary's MCP servers", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  await addAccount("spare", { places: homes.places, claudeBinary: CLAUDE_BINARY });
  const configPath = path.join(homes.places.accountsFolder, "spare", ".claude.json");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    migrationVersion: 14,
    opus45MigrationComplete: true,
    hasSeenAutoDefaultNudge: true,
  });
  assert.equal((await stat(configPath)).mode & ACCESS_MODE_BITS, 0o600);
  await assert.rejects(stat(path.join(homes.places.accountsFolder, "spare", ".credentials.json")));
});

test("account add registers an account folder already set up without recreating it", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  const secondaryConfig = await readFile(path.join(homes.secondaryFolder, ".claude.json"), "utf8");
  await addAccount("secondary", { places: homes.places, claudeBinary: CLAUDE_BINARY });
  assert.equal(await readFile(path.join(homes.secondaryFolder, ".claude.json"), "utf8"), secondaryConfig);
  assert.deepEqual(
    readAccountsConfig(homes.places.configPath)?.accounts.map((account) => account.name),
    ["primary", "secondary"],
  );
  const again = await addAccount("secondary", { places: homes.places, claudeBinary: CLAUDE_BINARY });
  assert.equal(again.some((line) => line.startsWith("linked")), false);
});
