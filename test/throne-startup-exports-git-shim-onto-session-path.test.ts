import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportGitShimToSession,
  sessionEnvExportLines,
} from "../src/throne-startup/session-env-export.ts";
import { run, type ThroneStartupDeps } from "../src/throne-startup/throne-startup.ts";

const LIVE_ROOT = "/court/throne";

test("session env lines put the live bin dir first on PATH and name the live root", () => {
  const lines = sessionEnvExportLines({ liveRoot: LIVE_ROOT, currentPath: "/usr/bin:/bin" });
  assert.deepEqual(lines, [
    `export THRONE_LIVE_ROOT='${LIVE_ROOT}'`,
    `export PATH='${LIVE_ROOT}/bin':"$PATH"`,
  ]);
});

test("session env lines leave PATH alone when the live bin dir is already on it", () => {
  const lines = sessionEnvExportLines({
    liveRoot: LIVE_ROOT,
    currentPath: `/usr/bin:${LIVE_ROOT}/bin:/bin`,
  });
  assert.deepEqual(lines, [`export THRONE_LIVE_ROOT='${LIVE_ROOT}'`]);
});

test("session env lines quote a root containing a single quote", () => {
  const lines = sessionEnvExportLines({ liveRoot: "/co'urt", currentPath: "" });
  assert.equal(lines[0], `export THRONE_LIVE_ROOT='/co'\\''urt'`);
});

test("export appends the lines to the session env file", async () => {
  const appended: Array<{ file: string; text: string }> = [];
  const outcome = await exportGitShimToSession({
    sessionEnvFile: "/tmp/session.env",
    liveRoot: async () => LIVE_ROOT,
    currentPath: "/usr/bin",
    appendToFile: async (file, text) => {
      appended.push({ file, text });
    },
    writeStderr: () => {},
  });
  assert.equal(outcome, "written");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.file, "/tmp/session.env");
  assert.equal(
    appended[0]?.text,
    `export THRONE_LIVE_ROOT='${LIVE_ROOT}'\nexport PATH='${LIVE_ROOT}/bin':"$PATH"\n`,
  );
});

test("export is a no-op without a session env file", async () => {
  let appends = 0;
  const outcome = await exportGitShimToSession({
    sessionEnvFile: undefined,
    liveRoot: async () => LIVE_ROOT,
    currentPath: "/usr/bin",
    appendToFile: async () => {
      appends += 1;
    },
    writeStderr: () => {},
  });
  assert.equal(outcome, "no-session-env-file");
  assert.equal(appends, 0);
});

test("export reports a failure instead of throwing", async () => {
  const errors: string[] = [];
  const outcome = await exportGitShimToSession({
    sessionEnvFile: "/tmp/session.env",
    liveRoot: async () => {
      throw new Error("no git here");
    },
    currentPath: "/usr/bin",
    appendToFile: async () => {},
    writeStderr: (text) => {
      errors.push(text);
    },
  });
  assert.equal(outcome, "failed");
  assert.match(errors.join(""), /no git here/);
});

test("throne-startup exports the shim before it gives up on a session outside herdr", async () => {
  let exported = 0;
  const deps = {
    currentPaneId: async () => {
      throw new Error("not inside herdr");
    },
    listAgents: async () => [],
    renameAgent: async () => {},
    renameTab: async () => {},
    throneRoot: LIVE_ROOT,
    installOmpExtension: async () => ({ kind: "already-installed" as const, target: "/x" }),
    renderQueueDigest: async () => "",
    readDesiredState: async () => ({ desired: "running" as const }),
    exportSessionEnv: async () => {
      exported += 1;
      return "written" as const;
    },
  } as unknown as ThroneStartupDeps;
  const code = await run([], deps);
  assert.equal(code, 0);
  assert.equal(exported, 1);
});
