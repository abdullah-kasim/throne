import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  exportGitShimToSession,
  sessionEnvExportLines,
} from "../src/throne-startup/session-env-export.ts";
import { run, type ThroneStartupDeps } from "../src/throne-startup/throne-startup.ts";

const LIVE_ROOT = "/court/throne";

test("session env lines put the live bin dir first on PATH exactly once and name the live root", async () => {
  const script = `${sessionEnvExportLines({ liveRoot: LIVE_ROOT }).join("\n")}\necho "$THRONE_LIVE_ROOT"; echo "$PATH"`;
  const { stdout } = await promisify(execFile)("bash", ["--noprofile", "--norc", "-c", script], {
    env: { PATH: `/usr/bin:${LIVE_ROOT}/bin:/bin:${LIVE_ROOT}/bin` },
  });
  assert.equal(stdout, `${LIVE_ROOT}\n${LIVE_ROOT}/bin:/usr/bin:/bin\n`);
});

test("session env lines quote a root containing a single quote", () => {
  const lines = sessionEnvExportLines({ liveRoot: "/co'urt" });
  assert.equal(lines[0], `export THRONE_LIVE_ROOT='/co'\\''urt'`);
});

test("export appends the lines to the session env file", async () => {
  const appended: Array<{ file: string; text: string }> = [];
  const outcome = await exportGitShimToSession({
    sessionEnvFile: "/tmp/session.env",
    liveRoot: async () => LIVE_ROOT,
    appendToFile: async (file, text) => {
      appended.push({ file, text });
    },
    writeStderr: () => {},
  });
  assert.equal(outcome, "written");
  assert.equal(appended.length, 1);
  assert.equal(appended[0]?.file, "/tmp/session.env");
  assert.equal(appended[0]?.text, `${sessionEnvExportLines({ liveRoot: LIVE_ROOT }).join("\n")}\n`);
});

test("export is a no-op without a session env file", async () => {
  let appends = 0;
  const outcome = await exportGitShimToSession({
    sessionEnvFile: undefined,
    liveRoot: async () => LIVE_ROOT,
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
