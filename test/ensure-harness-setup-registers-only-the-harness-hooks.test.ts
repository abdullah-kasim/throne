import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureHarnessSetup,
  parseThroneRoot,
  type EnsureHarnessSetupDependencies,
} from "../src/ensure-harness-setup/ensure-harness-setup.ts";
import { REAL_DEPS } from "../src/install-services/platform.ts";
import type { InstallServicesDeps } from "../src/install-services/install-services.types.ts";

const THRONE = "/srv/throne";

interface Harness {
  dependencies: EnsureHarnessSetupDependencies;
  stdout: string[];
  stderr: string[];
  notifications: string[];
  settings: { text: string | null };
  codexHooks: Map<string, string>;
  serviceCalls: string[];
}

function harness(initialSettings: string | null): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const notifications: string[] = [];
  const settings = { text: initialSettings };
  const codexHooks = new Map<string, string>();
  const serviceCalls: string[] = [];
  const installDeps: InstallServicesDeps = {
    ...REAL_DEPS,
    claudeSettingsPath: () => "/srv/home/.claude/settings.json",
    readClaudeSettings: async () => settings.text,
    writeClaudeSettings: async (_settingsPath, content) => {
      settings.text = content;
    },
    inspectInstalledUnit: async (targetPath) => {
      const content = codexHooks.get(targetPath);
      return content === undefined ? { kind: "missing" } : { kind: "file", content };
    },
    writeUnitFile: async (targetPath, content) => {
      codexHooks.set(targetPath, content);
    },
    launchctl: async (args) => {
      serviceCalls.push(`launchctl ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    systemctl: async (args) => {
      serviceCalls.push(`systemctl ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
  } as InstallServicesDeps;
  return {
    dependencies: {
      installDeps,
      notifyLord: async (message) => {
        notifications.push(message);
      },
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
    notifications,
    settings,
    codexHooks,
    serviceCalls,
  };
}

test("a machine with no hooks gets all three added, and a second run reports them unchanged", async () => {
  const machine = harness(null);

  assert.equal(await ensureHarnessSetup(THRONE, machine.dependencies), 0);
  assert.deepEqual(machine.stdout, [
    "ensure-harness-setup: claude scratch path guard: added\n",
    "ensure-harness-setup: claude skill write guard: added\n",
    "ensure-harness-setup: codex session start: added\n",
  ]);
  assert.match(machine.settings.text ?? "", /\/srv\/throne\/claude-hooks\/scratch-path-guard\.py/);
  assert.match(machine.settings.text ?? "", /\/srv\/throne\/claude-hooks\/skill-write-guard\.py/);
  assert.match(
    machine.codexHooks.get("/srv/throne/.codex/hooks.json") ?? "",
    /\/srv\/throne\/bin\/throne-cli throne-startup/,
  );

  machine.stdout.length = 0;
  assert.equal(await ensureHarnessSetup(THRONE, machine.dependencies), 0);
  assert.deepEqual(machine.stdout, [
    "ensure-harness-setup: claude scratch path guard: unchanged\n",
    "ensure-harness-setup: claude skill write guard: unchanged\n",
    "ensure-harness-setup: codex session start: unchanged\n",
  ]);
  assert.deepEqual(machine.notifications, []);
  assert.deepEqual(machine.serviceCalls, []);
});

test("a malformed settings file fails both claude hooks with the reason and notifies the Lord", async () => {
  const machine = harness("{ not json");

  assert.equal(await ensureHarnessSetup(THRONE, machine.dependencies), 1);
  assert.equal(machine.stderr.length, 2);
  assert.match(machine.stderr[0], /^ensure-harness-setup: claude scratch path guard: failed: .*is not valid JSON/);
  assert.match(machine.stderr[1], /^ensure-harness-setup: claude skill write guard: failed: .*is not valid JSON/);
  assert.deepEqual(machine.stdout, ["ensure-harness-setup: codex session start: added\n"]);
  assert.equal(machine.settings.text, "{ not json");
  assert.equal(machine.notifications.length, 1);
  assert.match(machine.notifications[0], /could not register its harness hooks for \/srv\/throne/);
});

test("a notification that cannot be sent is reported and the exit code still says failed", async () => {
  const machine = harness("[]");
  machine.dependencies.notifyLord = async () => {
    throw new Error("ntfy unreachable");
  };

  assert.equal(await ensureHarnessSetup(THRONE, machine.dependencies), 1);
  assert.match(machine.stderr.at(-1) ?? "", /could not notify the Lord: ntfy unreachable/);
});

test("an explicit throne root wins and a worktree default is refused", () => {
  assert.equal(parseThroneRoot(["--throne-root", "/live/throne"], "/anywhere"), "/live/throne");
  assert.equal(parseThroneRoot(["--throne-root=/live/throne"], "/anywhere"), "/live/throne");
  const refused = parseThroneRoot([], import.meta.dirname);
  assert.ok(refused instanceof Error);
  assert.ok(parseThroneRoot(["--dry-run"], "/anywhere") instanceof Error);
});
