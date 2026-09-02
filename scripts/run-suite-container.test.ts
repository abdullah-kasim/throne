import assert from "node:assert/strict";
import test from "node:test";
import {
  createSuiteContainerCommand,
  createSuiteContainerMountArguments,
  createSuiteContainerRunArguments,
  resolveSuiteContainerEnvironment,
} from "./run-suite-container.mjs";
import { SUITE_CONTAINER_NAME_PATTERN } from "./suite-container-cleanup.mjs";
import { verifySuiteRunTornDown } from "./suite-container-leak-guard.mjs";
import { applyTenSecondLawGate } from "./suite-duration-gate.mjs";

test("applyTenSecondLawGate fails an ordinary run whose captured output reports an item over ten seconds, even when the underlying status was 0", () => {
  const suiteOutput = "✔ some slow item (12000ms)\nℹ tests 1\n";
  const violationLines = [];

  const result = applyTenSecondLawGate(0, suiteOutput, {
    isHeavyTier: false,
    writeViolation: (line) => violationLines.push(line),
  });

  assert.notEqual(result, 0);
  assert.equal(violationLines.length, 1);
  assert.match(violationLines[0], /12000ms/);
  assert.match(violationLines[0], /10000ms/);
});

test("applyTenSecondLawGate leaves an ordinary run's status untouched when no item exceeds the threshold", () => {
  const suiteOutput = "✔ some fast item (9000ms)\nℹ tests 1\n";
  const violationLines = [];

  const result = applyTenSecondLawGate(0, suiteOutput, {
    isHeavyTier: false,
    writeViolation: (line) => violationLines.push(line),
  });

  assert.equal(result, 0);
  assert.equal(violationLines.length, 0);
});

test("applyTenSecondLawGate does not evaluate at all for the heavy tier, even when an item exceeds ten seconds", () => {
  const suiteOutput = "✔ a legitimately long real-infra item (45000ms)\nℹ tests 1\n";
  const violationLines = [];

  const result = applyTenSecondLawGate(0, suiteOutput, {
    isHeavyTier: true,
    writeViolation: (line) => violationLines.push(line),
  });

  assert.equal(result, 0);
  assert.equal(violationLines.length, 0);
});

test("a suite container receives only run-scoped writable mounts", () => {
  const runRoot = "/home/runner/tmp/throne-suite-example";
  const configHome = "/home/runner/tmp/throne-herdr-example";
  const mountArguments = createSuiteContainerMountArguments({
    runRoot,
    configHome,
  });

  assert.deepEqual(mountArguments, [
    "--volume",
    `${runRoot}:${runRoot}`,
    "--volume",
    `${configHome}:${configHome}.seed:ro`,
    "--tmpfs",
    `${configHome}:mode=1777`,
  ]);
});

test("the container command seeds the tmpfs config home from the read-only host copy, then execs the suite", () => {
  const argv = createSuiteContainerCommand(
    { configHome: "/home/runner/tmp/throne-herdr-example" },
    ["node", "./scripts/herdr-suite-session.mjs", "run", "abc", "--", "npm", "test"],
  );
  assert.deepEqual(argv.slice(0, 6), [
    "sh",
    "-c",
    'cp -R "$1"/. "$2"/ && shift 2 && exec "$@"',
    "sh",
    "/home/runner/tmp/throne-herdr-example.seed",
    "/home/runner/tmp/throne-herdr-example",
  ]);
  assert.deepEqual(argv.slice(6), ["node", "./scripts/herdr-suite-session.mjs", "run", "abc", "--", "npm", "test"]);
});

test("the suite run container is named after the run and mapped to the host uid per runtime", () => {
  const podman = createSuiteContainerRunArguments("podman", "abc123", { uid: 1000, gid: 1000 });
  const docker = createSuiteContainerRunArguments("docker", "abc123", { uid: 1000, gid: 1000 });
  assert.deepEqual(podman.slice(0, 6), ["run", "--rm", "--name", "throne-suite-app-abc123", "--platform", "linux/amd64"]);
  assert.ok(podman.includes("--userns=keep-id"));
  assert.ok(!podman.includes("--user"));
  assert.deepEqual(docker.slice(0, 6), podman.slice(0, 6));
  assert.deepEqual(docker.slice(docker.indexOf("--user"), docker.indexOf("--user") + 2), ["--user", "1000:1000"]);
  assert.ok(!docker.includes("--userns=keep-id"));
  for (const argv of [podman, docker]) {
    assert.deepEqual(argv.slice(-2), ["--security-opt", "label=disable"]);
  }
});

test("the teardown guard names a container that outlived cleanup and stays quiet when none did", () => {
  assert.doesNotThrow(() => verifySuiteRunTornDown("abc123", "abc123", { listContainers: () => [] }));
  assert.throws(
    () =>
      verifySuiteRunTornDown("abc123", "abc123", {
        listContainers: (suiteKey: string) => [{ name: `throne-suite-app-${suiteKey}`, startedAt: undefined }],
      }),
    /leaked container\(s\) for run abc123 still present after cleanup: throne-suite-app-abc123/,
  );
});

test("the cleanup pattern recognizes both the named run container and compose-era service containers", () => {
  const match = (name: string) => SUITE_CONTAINER_NAME_PATTERN.exec(name)?.[1] ?? null;
  assert.equal(match("throne-suite-app-abc123"), "throne-suite-app-abc123");
  assert.equal(match("throne-suite-app-abc123-redis-1"), "throne-suite-app-abc123");
  assert.equal(match("throne-suite-app-abc123_redis_1"), "throne-suite-app-abc123");
  assert.equal(match("throne-ntfy"), null);
  assert.equal(match("throne-suite-app-abc123-extra"), null);
});

test("the suite container's TMPDIR and SHELL are the container's own, never the host's", () => {
  const previous = process.env.TMPDIR;
  const previousShell = process.env.SHELL;
  process.env.TMPDIR = "/var/folders/xx/T";
  process.env.SHELL = "/opt/homebrew/bin/bash";
  try {
    const env = resolveSuiteContainerEnvironment(
      {
        home: "/home/runner/tmp/throne-suite-x/home",
        configHome: "/c",
        xdgDataHome: "/x",
        dataHome: "/d",
        worktreesHome: "/w",
      },
      { sessionName: "throne-suite-x", runId: "x" },
    );
    assert.equal(env.TMPDIR, "/tmp");
    assert.equal(env.SHELL, "/bin/bash");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
});
