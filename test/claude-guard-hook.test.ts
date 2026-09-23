import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  guardHookCommand,
  installClaudeGuardHook,
  withGuardHookRegistered,
} from "../src/install-services/claude-guard-hook.ts";
import { REAL_DEPS } from "../src/install-services/platform.ts";
import type { InstallServicesDeps } from "../src/install-services/install-services.types.ts";

const run = promisify(execFile);
const THRONE = "/srv/throne";
const COMMAND = guardHookCommand(THRONE);
const RETIRED_COMMAND = 'python3 "$HOME/dotfiles/claude/hooks/rm-literal-home-guard.py"';
const WEB_FETCH_ENTRY = {
  matcher: "WebFetch",
  hooks: [{ type: "command", command: "python3 fetch-guard.py" }],
};

function commandsIn(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as { PreToolUse: { hooks: { command: string }[] }[] };
  return hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

test("the python guard hook's own unit tests pass", async () => {
  const hooksDirectory = join(import.meta.dirname, "..", "claude-hooks");
  const { stderr } = await run("python3", [
    "-m",
    "unittest",
    "discover",
    "-s",
    hooksDirectory,
    "-p",
    "test_*.py",
  ]);
  assert.match(stderr, /\nOK\s*$/);
});

test("settings with no hooks gain a Bash PreToolUse entry for the throne's guard", () => {
  const { settings, change } = withGuardHookRegistered({ model: "opus" }, COMMAND);
  assert.equal(change, "registered");
  assert.equal(settings.model, "opus");
  assert.deepEqual((settings.hooks as { PreToolUse: unknown[] }).PreToolUse, [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: COMMAND, timeout: 5, statusMessage: "scratch path guard" },
      ],
    },
  ]);
});

test("a second registration of the same path changes nothing", () => {
  const first = withGuardHookRegistered({}, COMMAND).settings;
  const second = withGuardHookRegistered(first, COMMAND);
  assert.equal(second.change, "unchanged");
  assert.equal(second.settings, first);
});

test("the dotfiles rm-literal-home-guard registration is replaced in place so the two never both run", () => {
  const { settings, change } = withGuardHookRegistered(
    {
      hooks: {
        PreToolUse: [
          WEB_FETCH_ENTRY,
          { matcher: "Bash", hooks: [{ type: "command", command: RETIRED_COMMAND, timeout: 5 }] },
        ],
        Stop: [{ hooks: [] }],
      },
    },
    COMMAND,
  );
  assert.equal(change, "replaced");
  assert.deepEqual(commandsIn(settings), ["python3 fetch-guard.py", COMMAND]);
  assert.deepEqual((settings.hooks as { Stop: unknown }).Stop, [{ hooks: [] }]);
});

test("a registration pointing at another throne checkout is repointed, and duplicates collapse to one", () => {
  const stale = guardHookCommand("/old/throne");
  const { settings, change } = withGuardHookRegistered(
    {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: stale }] },
          { matcher: "Bash", hooks: [{ type: "command", command: COMMAND }] },
        ],
      },
    },
    COMMAND,
  );
  assert.equal(change, "replaced");
  assert.deepEqual(commandsIn(settings), [COMMAND]);
});

function depsWithSettings(initial: string | null): InstallServicesDeps & { written: string[] } {
  const written: string[] = [];
  return {
    ...REAL_DEPS,
    written,
    claudeSettingsPath: () => "/srv/home/.claude/settings.json",
    readClaudeSettings: async () => initial,
    writeClaudeSettings: async (_settingsPath, content) => {
      written.push(content);
    },
  };
}

const OPTIONS = { dryRun: false, throneRoot: THRONE, throneRootExplicit: true };

test("install writes the registration once and reports unchanged on the re-run", async () => {
  const deps = depsWithSettings(null);
  assert.equal(await installClaudeGuardHook(deps, OPTIONS), "registered");
  assert.equal(deps.written.length, 1);
  const rerun = depsWithSettings(deps.written[0]);
  assert.equal(await installClaudeGuardHook(rerun, OPTIONS), "unchanged");
  assert.equal(rerun.written.length, 0);
});

test("a dry run reports the change without writing", async () => {
  const deps = depsWithSettings("{}");
  assert.equal(await installClaudeGuardHook(deps, { ...OPTIONS, dryRun: true }), "registered");
  assert.equal(deps.written.length, 0);
});

test("unreadable settings are left untouched and reported as an error", async () => {
  for (const text of ["{ not json", "[]"]) {
    const deps = depsWithSettings(text);
    assert.equal(await installClaudeGuardHook(deps, OPTIONS), "error");
    assert.equal(deps.written.length, 0);
  }
});
