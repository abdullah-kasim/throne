import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_STEERING_CONFIG,
  targetEffortForRole,
  validateSteeringOverride,
} from "../src/steering-user-config.ts";
import { effortRoleForAgent } from "../src/config.ts";
import {
  regentLaunchArgv,
  resolveConfiguredRegentLaunch,
} from "../src/regent-state/regent-state.service.ts";
import { resolveSpawnPolicy } from "../src/create-agent/policy.ts";
import {
  baseDeps,
  baseRequest,
} from "../src/create-agent/policy-test-fixtures.ts";

const SOURCE = "/checkout/config.user.ts";

test("roleEfforts accepts every role at every effort from 1 to 6", () => {
  for (const effort of [1, 2, 3, 4, 5, 6]) {
    const override = validateSteeringOverride(
      {
        roleEfforts: {
          alpha: effort,
          shadow: effort,
          shadowSlice99: effort,
          stager: effort,
          regent: effort,
        },
      },
      SOURCE,
    );
    assert.equal(override.roleEfforts?.regent, effort);
    assert.equal(override.roleEfforts?.shadowSlice99, effort);
  }
});

test("roleEfforts refuses an unknown role and names the key", () => {
  assert.throws(
    () => validateSteeringOverride({ roleEfforts: { lord: 3 } }, SOURCE),
    /`roleEfforts\.lord` is not a known role/,
  );
});

test("roleEfforts refuses an out-of-range or fractional effort and names the key", () => {
  for (const bad of [0, 7, 2.5, "3", null]) {
    assert.throws(
      () => validateSteeringOverride({ roleEfforts: { stager: bad } }, SOURCE),
      /`roleEfforts\.stager` must be an integer from 1 to 6/,
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("regentRoute accepts one harness and model pair and refuses anything else", () => {
  assert.deepEqual(
    validateSteeringOverride(
      { regentRoute: { harness: "claude", model: "opus" } },
      SOURCE,
    ).regentRoute,
    { harness: "claude", model: "opus" },
  );
  assert.throws(
    () =>
      validateSteeringOverride(
        { regentRoute: { harness: "claude", model: "opus", effort: 3 } },
        SOURCE,
      ),
    /`regentRoute\.effort` is not a known field/,
  );
  assert.throws(
    () => validateSteeringOverride({ regentRoute: [] }, SOURCE),
    /`regentRoute` must be a plain/,
  );
});

test("a role without its own effort falls back to activeTargetEffort", () => {
  const config = {
    ...DEFAULT_STEERING_CONFIG,
    activeTargetEffort: 2,
    roleEfforts: { alpha: 3 },
  };
  assert.equal(targetEffortForRole("alpha", config), 3);
  assert.equal(targetEffortForRole("shadow", config), 2);
  assert.equal(targetEffortForRole("regent", config), 2);
});

test("every agent role maps onto its effort key", () => {
  assert.equal(effortRoleForAgent("Alpha", "alpha-code-01"), "alpha");
  assert.equal(effortRoleForAgent("Shadow", "shadow-code-01", "code"), "shadow");
  assert.equal(
    effortRoleForAgent("Shadow", "shadow-code-99a", "code"),
    "shadowSlice99",
  );
  assert.equal(effortRoleForAgent("Stager", "stager-floor"), "stager");
  assert.equal(effortRoleForAgent("Regent", "Regent"), "regent");
  assert.equal(effortRoleForAgent("agent", "agent-x"), undefined);
});

test("with a configured route the Regent launches on that model at its role effort", () => {
  const launch = resolveConfiguredRegentLaunch(
    { harness: "claude", model: "opus" },
    3,
  );
  assert.ok(launch !== undefined);
  assert.equal(launch.effort, 3);
  const argv = regentLaunchArgv(launch, undefined, "claude");
  assert.ok(argv.join(" ").includes("--model"), argv.join(" "));
  assert.ok(argv.includes("high"), argv.join(" "));
});

test("without a configured route the Regent launch is exactly what it was", () => {
  assert.equal(resolveConfiguredRegentLaunch(undefined, 3), undefined);
  const bare = regentLaunchArgv(undefined, undefined, "claude");
  assert.equal(bare.length, 1);
  assert.match(bare[0]!, /claudey$/);
  const recorded = regentLaunchArgv(
    undefined,
    { harness: "claude", model: "sonnet" },
    "claude",
  );
  assert.ok(recorded.includes("low"), recorded.join(" "));
});

test("create-agent launches a Shadow at the effort configured for its role", async () => {
  const asked: string[] = [];
  const result = await resolveSpawnPolicy(
    baseRequest(),
    baseDeps({
      targetEffort: undefined,
      targetEffortForAgent: (role, name) => {
        asked.push(`${role}:${name}`);
        return 3;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.value.launchEffort, 3);
  assert.deepEqual(asked, ["Shadow:shadow-brg-test-01"]);
});

test("a campaign effort the Lord filed still outranks the role effort", async () => {
  const result = await resolveSpawnPolicy(
    baseRequest(),
    baseDeps({
      targetEffort: undefined,
      targetEffortForAgent: () => 3,
      readSpawnSpec: (async () => ({
        harness: "claude",
        model: "sonnet",
        effort: 2,
        cwd: "/tmp/alpha",
        objective_code: "brg",
        campaign_effort: 2,
      })) as never,
    }),
  );
  assert.equal(result.ok && result.value.launchEffort, 2);
});
