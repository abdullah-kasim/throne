import assert from "node:assert/strict";
import test from "node:test";

import {
  excludeProtectedServers,
  findResidualServers,
} from "../scripts/herdr-server-leak-guard.mjs";

test("a suite run reports a newly present owned fixture server as leaked residue", () => {
  const fixtureServer = {
    socketPath: "/scratch/herdr/sessions/throne-suite-run-42/herdr.sock",
    pid: 42,
    runId: "run-42",
  };

  const residualServers = findResidualServers([], [fixtureServer]);

  assert.deepEqual(residualServers, [fixtureServer]);
});

test("a protected live court holder never enters fixture residue classification", () => {
  const protectedCourtHolder = {
    socketPath: "/scratch/herdr/sessions/throne-suite-live/herdr.sock",
    pid: 7,
    runId: "live",
  };
  const leakedFixtureServer = {
    socketPath: "/scratch/herdr/sessions/throne-suite-run-42/herdr.sock",
    pid: 42,
    runId: "run-42",
  };

  const candidates = excludeProtectedServers(
    [protectedCourtHolder, leakedFixtureServer],
    new Set([protectedCourtHolder.pid]),
  );
  const residualServers = findResidualServers([], candidates);

  assert.deepEqual(residualServers, [leakedFixtureServer]);
  assert.equal(residualServers.includes(protectedCourtHolder), false);
});
