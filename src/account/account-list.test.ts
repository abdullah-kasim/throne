import assert from "node:assert/strict";
import { rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import { accountUsageCacheFile } from "../plan-usage-remaining/account-usage-cache.ts";
import { PlanUsagePlatformService } from "../plan-usage-remaining/plan-usage-platform.service.ts";
import { realPlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import type { HttpJsonRequest } from "../plan-usage-remaining/pipeline.types.ts";
import {
  credentialsText,
  linkSharedItemsInto,
  makeAccountHomes,
  NOW,
  PERSONAL_DOMAIN,
  PRIMARY_ACCESS_TOKEN,
  primaryUsageReader,
  usageEndpoint,
  type AccountHomes,
} from "./account-homes.test-support.ts";
import { listAccounts } from "./account-list.ts";

function liveAgent(name: string, harness = "claude"): HerdrAgent {
  return { agent: harness, name, agentStatus: "idle", cwd: "/work", focused: false, paneId: `pane-${name}`, tabId: `tab-${name}`, terminalId: `terminal-${name}` };
}

function spawnSpec(account?: string): SpawnSpec {
  return { harness: "claude", model: "opus", effort: 2, cwd: "/work", spawned_at: "2026-10-16T00:00:00Z", ...(account === undefined ? {} : { account }) };
}

function listWith(homes: AccountHomes, agents: HerdrAgent[] = [], specs: Record<string, SpawnSpec> = {}) {
  return listAccounts({
    places: homes.places,
    readPrimaryUsage: primaryUsageReader(),
    listAgents: async () => agents,
    readSpawnSpec: async (name) => specs[name] ?? null,
    readOptions: { httpJson: usageEndpoint().httpJson },
  });
}

function withoutReadingAges(lines: string[]): string[] {
  return lines.map((line) => line.replace(/\(read \d+ (?:s|min) ago, /, "("));
}

test("account list shows each account's folder, login, usage, live agents and the long-running account", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const homes = await makeAccountHomes({ longRunningAccount: "secondary" });
  await linkSharedItemsInto(homes.secondaryFolder, homes);
  const lines = await listWith(
    homes,
    [liveAgent("alpha-one"), liveAgent("shadow-two"), liveAgent("stager-three")],
    { "alpha-one": spawnSpec(), "shadow-two": spawnSpec("secondary"), "stager-three": spawnSpec("secondary") },
  );
  assert.deepEqual(withoutReadingAges(lines), [
    `primary — ${homes.primaryFolder}`,
    "  login: logged in as company.example, organisation company-organisation; the company login",
    "  usage: 5h 30% used, weekly 40% used (fresh)",
    "  live agents: alpha-one",
    "  MCP servers at launch: company-chat, company-tracker, local-notes; denied: none",
    "  claude.ai connectors: on at launch",
    `secondary — ${homes.secondaryFolder}`,
    `  login: logged in as ${PERSONAL_DOMAIN}, organisation personal-organisation; not the company login`,
    "  usage: 5h 55% used, weekly 91% used (fresh)",
    "  live agents: shadow-two, stager-three",
    "  MCP servers at launch: local-notes; denied: company-chat, company-tracker",
    "  claude.ai connectors: switched off at launch",
    "  links: all in place",
    "long-running account (Stagers and the Regent): secondary",
  ]);
});

test("account list reports a link that is missing or points elsewhere", async () => {
  const homes = await makeAccountHomes();
  await linkSharedItemsInto(homes.secondaryFolder, homes);
  await rm(path.join(homes.secondaryFolder, "hooks"));
  const settingsLink = path.join(homes.secondaryFolder, "settings.json");
  await unlink(settingsLink);
  await symlink(path.join(homes.primaryFolder, "settings.json"), settingsLink);
  const lines = await listWith(homes);
  assert.equal(
    lines.find((line) => line.includes("link drift")),
    `  link drift: hooks -> ${path.join(homes.primaryFolder, "hooks")}: missing; ` +
      `settings.json -> ${homes.settingsTarget}: points to ${path.join(homes.primaryFolder, "settings.json")}`,
  );
});

test("account list reports a folder whose login is not the company login", async () => {
  const homes = await makeAccountHomes({ primaryDomain: PERSONAL_DOMAIN, secondaryLoggedIn: false });
  const lines = await listWith(homes);
  assert.equal(lines[1], `  login: logged in as ${PERSONAL_DOMAIN}, organisation company-organisation; not the company login`);
  assert.equal(lines[4], "  MCP servers at launch: local-notes; denied: company-chat, company-tracker");
  assert.equal(lines[5], "  claude.ai connectors: switched off at launch");
  assert.equal(lines[7], `  login: logged out (last login ${PERSONAL_DOMAIN}, organisation personal-organisation); not the company login`);
  assert.equal(lines[8], "  usage: no reading (logged out)");
});

test("account list without an accounts file says the throne runs on the primary folder", async () => {
  const homes = await makeAccountHomes({ writeAccountsFile: false });
  assert.deepEqual(await listWith(homes), [
    `No accounts are configured (${homes.places.configPath} is absent); the throne runs every agent on ${homes.primaryFolder}.`,
  ]);
});

test("account list shows how old each usage reading is and whether it is fresh, cached, or the last good reading after a 429", async () => {
  const homes = await makeAccountHomes();
  let nowMs = NOW.getTime();
  const now = () => new Date(nowMs);
  const statuses = [200, 429];
  let requests = 0;
  const httpJson = async (_request: HttpJsonRequest) => {
    const status = statuses[Math.min(requests, statuses.length - 1)]!;
    requests += 1;
    return {
      status,
      json: { five_hour: { utilization: 30, resets_at: "2026-10-16T15:00:00Z" }, seven_day: { utilization: 40, resets_at: "2026-10-20T00:00:00Z" } },
    };
  };
  const primaryUsage = realPlanUsageRemainingService(
    new PlanUsagePlatformService({
      readCredentialsFile: async () => credentialsText(PRIMARY_ACCESS_TOKEN),
      httpJson,
      now,
      out: () => undefined,
      errOut: () => undefined,
      usageCacheFile: accountUsageCacheFile(homes.primaryFolder),
    }),
  );
  const primaryUsageLineAfter = async (minutes: number) => {
    nowMs += minutes * 60_000;
    const lines = await listAccounts({
      places: homes.places,
      readPrimaryUsage: () => primaryUsage.getUsagePayload(),
      listAgents: async () => [],
      readSpawnSpec: async () => null,
      readOptions: { httpJson: usageEndpoint().httpJson },
      now,
    });
    return lines[2];
  };
  assert.equal(await primaryUsageLineAfter(0), "  usage: 5h 30% used, weekly 40% used (read 0 s ago, fresh)");
  assert.equal(await primaryUsageLineAfter(0.75), "  usage: 5h 30% used, weekly 40% used (read 45 s ago, cached)");
  assert.equal(await primaryUsageLineAfter(1), "  usage: 5h 30% used, weekly 40% used (read 1 min ago, cached)");
  assert.equal(await primaryUsageLineAfter(2), "  usage: 5h 30% used, weekly 40% used (read 3 min ago, last good after a 429)");
  assert.equal(requests, 2);
});
