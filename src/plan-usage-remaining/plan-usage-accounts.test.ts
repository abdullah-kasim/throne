import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  credentialsText,
  primaryUsageService,
  SECONDARY_ACCESS_TOKEN,
  usageEndpoint,
} from "../account/account-homes.test-support.ts";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import { planUsageCommandResult } from "./plan-usage-accounts.ts";
import { PlanUsagePresentationService } from "./plan-usage-presentation.service.ts";

async function accountHomes(options: { secondaryLoggedIn: boolean }) {
  const userHome = await makeScratchDirectory("plan-usage-accounts-");
  const secondaryFolder = path.join(userHome, "accounts", "secondary");
  await mkdir(path.join(userHome, ".claude"));
  await mkdir(secondaryFolder, { recursive: true });
  await writeFile(
    path.join(userHome, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "someone@company.example" } }),
  );
  await writeFile(
    path.join(secondaryFolder, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "someone@personal.example" } }),
  );
  if (options.secondaryLoggedIn) {
    await writeFile(path.join(secondaryFolder, ".credentials.json"), credentialsText(SECONDARY_ACCESS_TOKEN));
  }
  const configPath = path.join(userHome, "accounts.json");
  await writeFile(
    configPath,
    JSON.stringify({
      accounts: [
        { name: "primary", harness: "claude", folder: path.join(userHome, ".claude") },
        { name: "secondary", harness: "claude", folder: secondaryFolder },
      ],
    }),
  );
  return { userHome, configPath };
}

async function runCommand(args: string[], configPath: string, userHome: string) {
  const endpoint = usageEndpoint();
  const result = await planUsageCommandResult(
    args,
    primaryUsageService(endpoint.httpJson),
    new PlanUsagePresentationService(),
    configPath,
    { userHome, httpJson: endpoint.httpJson },
  );
  return { result, requests: endpoint.requests };
}

test("plan-usage-remaining shows one row per configured account", async () => {
  const { userHome, configPath } = await accountHomes({ secondaryLoggedIn: true });
  const text = await runCommand([], configPath, userHome);
  assert.equal(text.result.exitCode, 0);
  assert.equal(
    text.result.stdout,
    "primary: Claude plan usage — 5h: 70% remaining (resets 2026-10-16T15:00:00Z) · weekly: 60% remaining (resets 2026-10-20T00:00:00Z)\n" +
      "secondary: Claude plan usage — 5h: 45% remaining (resets 2026-10-16T15:00:00Z) · weekly: 9% remaining (resets 2026-10-20T00:00:00Z)\n",
  );
  assert.equal(text.requests.length, 2);

  const json = await runCommand(["--json"], configPath, userHome);
  const payload = JSON.parse(json.result.stdout ?? "");
  assert.equal(payload.source, "api");
  assert.deepEqual(payload.windows.map((window: { remaining_pct: number }) => window.remaining_pct), [70, 60]);
  assert.deepEqual(
    payload.accounts.map((account: { name: string; logged_in: boolean; usage: { windows: { remaining_pct: number }[] } }) => [
      account.name,
      account.logged_in,
      account.usage.windows.map((window) => window.remaining_pct),
    ]),
    [["primary", true, [70, 60]], ["secondary", true, [45, 9]]],
  );
});

test("plan-usage-remaining names an account it cannot read", async () => {
  const { userHome, configPath } = await accountHomes({ secondaryLoggedIn: false });
  const text = await runCommand([], configPath, userHome);
  assert.equal(text.result.exitCode, 0);
  assert.equal(text.result.stdout?.split("\n")[1], "secondary: logged out, no usage reading");
  assert.equal(text.requests.length, 1);

  const json = await runCommand(["--json"], configPath, userHome);
  assert.deepEqual(JSON.parse(json.result.stdout ?? "").accounts[1], { name: "secondary", logged_in: false });
});

test("without an accounts file plan-usage-remaining prints what it prints today", async () => {
  const userHome = await makeScratchDirectory("plan-usage-accounts-");
  const missingConfigPath = path.join(userHome, "accounts.json");
  const text = await runCommand([], missingConfigPath, userHome);
  assert.deepEqual(text.result, {
    exitCode: 0,
    stdout:
      "Claude plan usage — 5h: 70% remaining (resets 2026-10-16T15:00:00Z) · weekly: 60% remaining (resets 2026-10-20T00:00:00Z)\n",
  });
  const json = await runCommand(["--json"], missingConfigPath, userHome);
  const payload = JSON.parse(json.result.stdout ?? "");
  assert.equal(payload.accounts, undefined);
  assert.deepEqual(Object.keys(payload).sort(), ["as_of", "harness", "reading_source", "source", "windows"]);
});
