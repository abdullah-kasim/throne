import assert from "node:assert/strict";
import { test } from "node:test";
import { makeAccountHomes } from "../account/account-homes.test-support.ts";
import { renderAccountLines } from "./check-config.ts";

test("check-config prints one line per account", async () => {
  const homes = await makeAccountHomes({ secondaryLoggedIn: false });
  assert.equal(
    await renderAccountLines(homes.places.configPath, homes.places.userHome),
    `account primary: ${homes.primaryFolder}, logged in\n` + `account secondary: ${homes.secondaryFolder}, logged out\n`,
  );
});

test("check-config prints no account line without an accounts file", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  assert.equal(await renderAccountLines(homes.places.configPath, homes.places.userHome), "");
});
