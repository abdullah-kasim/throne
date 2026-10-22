import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAccountsConfig } from "../../account/accounts-config.ts";
import { chooseSpawnAccount, type AccountReading, type SpawnAccountRequest } from "./account-balance.ts";
import { readHarnessUsage } from "./usage.ts";

const CONFIG = parseAccountsConfig(
  JSON.stringify({
    accounts: [
      { name: "primary", harness: "claude", folder: "/Users/theuser/.claude" },
      { name: "secondary", harness: "claude", folder: "/Users/theuser/accounts/secondary" },
    ],
    companyLogin: { emailDomain: "example.com" },
  }),
  "accounts.json",
);

function usedWindows(sessionUsedPct: number, weeklyUsedPct: number, fableUsedPct = 0) {
  return readHarnessUsage({
    source: "api",
    windows: [
      { cap_window: "5h", used_pct: sessionUsedPct, remaining_pct: 100 - sessionUsedPct },
      { cap_window: "weekly", used_pct: weeklyUsedPct, remaining_pct: 100 - weeklyUsedPct },
      { cap_window: "weekly:Fable", used_pct: fableUsedPct, remaining_pct: 100 - fableUsedPct, scope_model: "Fable" },
    ],
  });
}

function reading(name: string, usage = usedWindows(0, 0), overrides: Partial<AccountReading> = {}): AccountReading {
  return { name, loggedIn: true, isCompany: false, loginDescription: "example.org", usage, ...overrides };
}

function shadowSpawn(readings: AccountReading[], extra: Partial<SpawnAccountRequest> = {}): SpawnAccountRequest {
  return { role: "Shadow", config: CONFIG, readings, ...extra };
}

test("a new agent goes to the primary while both all-models windows are under 90% used", () => {
  const choice = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(89, 89)), reading("secondary")]));
  assert.equal(choice.kind, "account");
  assert.equal(choice.kind === "account" && choice.name, "primary");
});

test("a new agent goes to the secondary once the primary's 5-hour window reaches 90% used", () => {
  const choice = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(90, 10)), reading("secondary")]));
  assert.equal(choice.kind === "account" && choice.name, "secondary");
});

test("a new agent goes to the secondary once the primary's weekly window reaches 90% used", () => {
  const choice = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(10, 90)), reading("secondary")]));
  assert.equal(choice.kind === "account" && choice.name, "secondary");
});

test("the Fable window at 100% used does not move a new agent off the primary", () => {
  const choice = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(20, 20, 100)), reading("secondary")]));
  assert.equal(choice.kind === "account" && choice.name, "primary");
});

test("a new agent goes back to the primary after its window resets", () => {
  const full = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(95, 40)), reading("secondary")]));
  const reset = chooseSpawnAccount(shadowSpawn([reading("primary", usedWindows(0, 40)), reading("secondary")]));
  assert.equal(full.kind === "account" && full.name, "secondary");
  assert.equal(reset.kind === "account" && reset.name, "primary");
});

test("an account with no usage reading is skipped and named", () => {
  const choice = chooseSpawnAccount(
    shadowSpawn([reading("primary", readHarnessUsage({ source: "error", error: "sensor down" })), reading("secondary")]),
  );
  assert.equal(choice.kind === "account" && choice.name, "secondary");
  assert.match(choice.kind === "account" ? choice.reason : "", /skipped, no usage reading: primary/);
});

test("every account at its limit pauses the spawn", () => {
  const choice = chooseSpawnAccount(
    shadowSpawn([reading("primary", usedWindows(100, 50)), reading("secondary", usedWindows(30, 100))]),
  );
  assert.equal(choice.kind, "pause");
});

test("a primary over 90% used but not at its limit still takes a spawn the secondary cannot", () => {
  const choice = chooseSpawnAccount(
    shadowSpawn([reading("primary", usedWindows(95, 50)), reading("secondary", usedWindows(0, 0), { loggedIn: false })]),
  );
  assert.equal(choice.kind === "account" && choice.name, "primary");
});

test("a Stager and the Regent go to the long-running account at any usage", () => {
  const config = { ...CONFIG, longRunningAccount: "secondary" };
  const readings = [reading("primary"), reading("secondary", usedWindows(100, 100))];
  for (const role of ["Stager", "Regent"]) {
    const choice = chooseSpawnAccount({ role, config, readings });
    assert.equal(choice.kind === "account" && choice.name, "secondary", role);
  }
  const unset = chooseSpawnAccount({ role: "Regent", config: CONFIG, readings: [reading("primary", usedWindows(100, 100)), reading("secondary")] });
  assert.equal(unset.kind === "account" && unset.name, "primary");
});

test("an explicit account overrides the balancer", () => {
  const choice = chooseSpawnAccount(
    shadowSpawn([reading("primary"), reading("secondary")], { explicitAccount: "secondary" }),
  );
  assert.equal(choice.kind === "account" && choice.name, "secondary");
});

test("an unknown or logged-out account is refused naming the configured accounts", () => {
  const readings = [reading("primary"), reading("secondary", usedWindows(0, 0), { loggedIn: false })];
  const unknown = chooseSpawnAccount(shadowSpawn(readings, { explicitAccount: "tertiary" }));
  const loggedOut = chooseSpawnAccount(shadowSpawn(readings, { explicitAccount: "secondary" }));
  for (const choice of [unknown, loggedOut]) {
    assert.equal(choice.kind, "refuse");
    assert.match(choice.kind === "refuse" ? choice.message : "", /configured accounts: primary \(example\.org\), secondary \(not logged in\)/);
  }
});

test("company work goes to the account logged in as the company and waits when it is at its limit", () => {
  const companySecondary = reading("secondary", usedWindows(95, 50), { isCompany: true });
  const required = chooseSpawnAccount(shadowSpawn([reading("primary"), companySecondary], { requirement: "company" }));
  const explicit = chooseSpawnAccount(shadowSpawn([reading("primary"), companySecondary], { explicitAccount: "company" }));
  assert.equal(required.kind === "account" && required.name, "secondary");
  assert.equal(explicit.kind === "account" && explicit.name, "secondary");

  const atLimit = chooseSpawnAccount(
    shadowSpawn([reading("primary"), reading("secondary", usedWindows(100, 50), { isCompany: true })], { requirement: "company" }),
  );
  assert.equal(atLimit.kind, "pause");
  assert.match(atLimit.kind === "pause" ? atLimit.reason : "", /waits for the company account secondary/);

  const noCompany = chooseSpawnAccount(shadowSpawn([reading("primary"), reading("secondary")], { requirement: "company" }));
  assert.equal(noCompany.kind, "refuse");
});
