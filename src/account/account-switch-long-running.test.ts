import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { writeIdentity } from "../agentdata/identity-data.service.ts";
import { recordAccountInIdentity } from "../agentdata/identity-account-line.ts";
import type { SpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { accountForLongRunningRoles } from "../harness-routing/policy/account-balance.ts";
import type { HerdrAgent } from "../herdr/herdr-identity-contracts.ts";
import type { RestartOutcome } from "../restart-harnesses/restart-harnesses-runtime.ts";
import { claudeProjectDirectory } from "../session/runtime-model-acceptance.ts";
import { makeAccountHomes, type AccountHomes } from "./account-homes.test-support.ts";
import { AccountSwitchRefusal, switchLongRunningAccount } from "./account-switch-long-running.ts";
import { readAccountsConfig } from "./accounts-config.ts";

interface Court {
  readonly homes: AccountHomes;
  readonly specs: Map<string, SpawnSpec>;
  readonly restartRequests: { names: string[]; accounts: (string | undefined)[] }[];
  readonly ledger: string;
  readonly run: (name: string) => ReturnType<typeof switchLongRunningAccount>;
}

const ROLES: Record<string, string> = { "stager-one": "Stager", "stager-two": "Stager", "alpha-one": "Alpha" };

async function makeCourt(options: { secondaryLoggedIn?: boolean; unrecorded?: string[] } = {}): Promise<Court> {
  const homes = await makeAccountHomes(options);
  const cwd = path.join(homes.places.userHome, "work");
  await mkdir(cwd);
  const agents: HerdrAgent[] = ["stager-one", "Regent", "alpha-one", "stager-two"].map((name) => ({
    agent: "claude",
    name,
    agentStatus: "working",
    sessionId: `session-of-${name}`,
    cwd,
    focused: false,
    paneId: `pane-${name}`,
    tabId: `tab-${name}`,
    terminalId: `terminal-${name}`,
  }));
  const specs = new Map<string, SpawnSpec>(
    agents.map((agent) => [
      agent.name!,
      {
        harness: "claude",
        model: "opus",
        effort: 2,
        cwd,
        spawned_at: "2026-10-16T00:00:00Z",
        session_id: agent.sessionId,
        ...(agent.name === "stager-two" ? { account: "secondary" } : {}),
      },
    ]),
  );
  for (const name of options.unrecorded ?? []) specs.delete(name);
  const primaryProjects = claudeProjectDirectory(cwd, path.join(homes.primaryFolder, "projects"));
  await mkdir(path.join(primaryProjects, "session-of-stager-one", "subagents"), { recursive: true });
  await writeFile(path.join(primaryProjects, "session-of-stager-one", "subagents", "helper.jsonl"), "helper\n");
  for (const name of ["stager-one", "Regent"]) {
    await writeFile(path.join(primaryProjects, `session-of-${name}.jsonl`), `transcript of ${name}\n`);
  }
  const ledger = path.join(homes.places.userHome, "ledger");
  for (const name of ["stager-one", "Regent"]) {
    await writeIdentity(
      name,
      {
        role: ROLES[name] ?? "Regent",
        supervisor: "Lord",
        escalation: "Lord",
        ...(name === "Regent" ? {} : { account: "primary" }),
      },
      ledger,
    );
  }
  const restartRequests: Court["restartRequests"] = [];
  const run = (name: string) =>
    switchLongRunningAccount(name, {
      places: homes.places,
      listAgents: async () => agents,
      readRole: async (agentName) => ROLES[agentName],
      readSpawnSpec: async (agentName) => specs.get(agentName) ?? null,
      writeSpawnSpec: async (agentName, spec) => {
        specs.set(agentName, spec);
      },
      recordAccountInIdentity: (agentName, account) => recordAccountInIdentity(agentName, account, ledger),
      restartInPlace: async (names): Promise<RestartOutcome[]> => {
        restartRequests.push({ names: [...names], accounts: names.map((agentName) => specs.get(agentName)?.account) });
        return names.map((agentName) => ({ name: agentName, verdict: "restarted", detail: `resumed native session session-of-${agentName}` }));
      },
    });
  return { homes, specs, restartRequests, ledger, run };
}

test("switching the long-running account records it for Stagers and the Regent", async () => {
  const court = await makeCourt();
  await court.run("secondary");
  const config = readAccountsConfig(court.homes.places.configPath)!;
  assert.equal(config.longRunningAccount, "secondary");
  assert.equal(accountForLongRunningRoles(config), "secondary");
  assert.deepEqual(config.accounts.map((account) => account.name), ["primary", "secondary"]);
});

test("switching the long-running account restarts each live Stager and the Regent in place", async () => {
  const court = await makeCourt();
  const result = await court.run("secondary");
  assert.deepEqual(court.restartRequests, [{ names: ["stager-one", "Regent"], accounts: ["secondary", "secondary"] }]);
  assert.equal(court.specs.get("alpha-one")?.account, undefined);
  assert.equal(result.failed, false);
  assert.deepEqual(result.lines, [
    "account switch-long-running: Stagers and the Regent now start on secondary",
    "account switch-long-running: unchanged stager-two — already on secondary",
    "account switch-long-running: moved     stager-one to secondary — resumed native session session-of-stager-one",
    "account switch-long-running: moved     Regent to secondary — resumed native session session-of-Regent",
  ]);
});

test("switching the long-running account carries each session into the target folder", async () => {
  const court = await makeCourt();
  await court.run("secondary");
  const cwd = path.join(court.homes.places.userHome, "work");
  const primaryProjects = claudeProjectDirectory(cwd, path.join(court.homes.primaryFolder, "projects"));
  const secondaryProjects = claudeProjectDirectory(cwd, path.join(court.homes.secondaryFolder, "projects"));
  for (const name of ["stager-one", "Regent"]) {
    assert.equal(await readFile(path.join(secondaryProjects, `session-of-${name}.jsonl`), "utf8"), `transcript of ${name}\n`);
    assert.equal(await readFile(path.join(primaryProjects, `session-of-${name}.jsonl`), "utf8"), `transcript of ${name}\n`);
  }
  assert.equal(
    await readFile(path.join(secondaryProjects, "session-of-stager-one", "subagents", "helper.jsonl"), "utf8"),
    "helper\n",
  );
});

test("switching to an unknown or logged-out account is refused naming the configured accounts", async () => {
  const court = await makeCourt({ secondaryLoggedIn: false });
  const configBefore = await readFile(court.homes.places.configPath, "utf8");
  await assert.rejects(court.run("spare"), (error: unknown) => {
    assert.ok(error instanceof AccountSwitchRefusal);
    assert.equal(error.message, 'unknown account "spare"; the configured accounts are primary, secondary');
    return true;
  });
  await assert.rejects(court.run("secondary"), (error: unknown) => {
    assert.ok(error instanceof AccountSwitchRefusal);
    assert.equal(error.message, 'account "secondary" is logged out; the configured accounts are primary, secondary');
    return true;
  });
  assert.equal(await readFile(court.homes.places.configPath, "utf8"), configBefore);
  assert.deepEqual(court.restartRequests, []);
});

test("switching the long-running account moves an agent that has no spawn.json", async () => {
  const court = await makeCourt({ unrecorded: ["stager-one", "stager-two"] });
  const result = await court.run("secondary");
  const cwd = path.join(court.homes.places.userHome, "work");
  const secondaryProjects = claudeProjectDirectory(cwd, path.join(court.homes.secondaryFolder, "projects"));
  assert.deepEqual(court.restartRequests.map((request) => request.names), [["stager-one", "Regent"]]);
  assert.equal(court.specs.has("stager-one"), false);
  assert.equal(await readFile(path.join(secondaryProjects, "session-of-stager-one.jsonl"), "utf8"), "transcript of stager-one\n");
  assert.ok(result.lines.includes("account switch-long-running: moved     stager-one to secondary — resumed native session session-of-stager-one"));
  const unfoundSessionLine = result.lines.find((line) => line.includes("stager-two"));
  assert.match(unfoundSessionLine ?? "", /^account switch-long-running: failed {4}stager-two — .*session-of-stager-two\.jsonl.*; left running on primary$/);
  assert.equal(result.failed, true);
});

test("switching the long-running account records the new account in identity.md as in spawn.json", async () => {
  const court = await makeCourt();
  await court.run("secondary");
  for (const name of ["stager-one", "Regent"]) {
    const identity = await readFile(path.join(court.ledger, name, "identity.md"), "utf8");
    assert.equal(court.specs.get(name)?.account, "secondary");
    assert.deepEqual(identity.split("\n").filter((line) => line.startsWith("- **Account:**")), ["- **Account:** secondary"]);
  }
});
