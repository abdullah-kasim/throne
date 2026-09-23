import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installSkillWriteGuardHook,
  skillWriteGuardHookCommand,
  withSkillWriteGuardRegistered,
} from "../src/install-services/skill-write-guard-hook.ts";
import { REAL_DEPS } from "../src/install-services/platform.ts";
import type { InstallServicesDeps } from "../src/install-services/install-services.types.ts";

const THRONE = "/srv/throne";
const COMMAND = skillWriteGuardHookCommand(THRONE);
const COMMENT_GUARD_HOOK = { type: "command", command: "python3 comment-guard.py" };

function commandsIn(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as { PostToolUse: { hooks: { command: string }[] }[] };
  return hooks.PostToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
}

test("empty settings gain a PostToolUse Edit|Write entry for the skill write guard", () => {
  const { settings, change } = withSkillWriteGuardRegistered({ model: "opus" }, COMMAND);
  assert.equal(change, "registered");
  assert.equal(settings.model, "opus");
  assert.deepEqual((settings.hooks as { PostToolUse: unknown[] }).PostToolUse, [
    {
      matcher: "Edit|Write",
      hooks: [{ type: "command", command: COMMAND }],
    },
  ]);
});

test("a second registration of the same command changes nothing", () => {
  const first = withSkillWriteGuardRegistered({}, COMMAND).settings;
  const second = withSkillWriteGuardRegistered(first, COMMAND);
  assert.equal(second.change, "unchanged");
  assert.equal(second.settings, first);
});

test("a stale prior registration is replaced in place", () => {
  const stale = skillWriteGuardHookCommand("/old/throne");
  const { settings, change } = withSkillWriteGuardRegistered(
    {
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [{ type: "command", command: stale }] },
        ],
      },
    },
    COMMAND,
  );
  assert.equal(change, "replaced");
  assert.deepEqual(commandsIn(settings), [COMMAND]);
});

test("an existing comment-guard.py entry on the same matcher is preserved alongside the new hook", () => {
  const { settings, change } = withSkillWriteGuardRegistered(
    {
      hooks: {
        PostToolUse: [
          { matcher: "Edit|Write", hooks: [COMMENT_GUARD_HOOK] },
        ],
        Stop: [{ hooks: [] }],
      },
    },
    COMMAND,
  );
  assert.equal(change, "registered");
  assert.deepEqual(commandsIn(settings), ["python3 comment-guard.py", COMMAND]);
  assert.deepEqual((settings.hooks as { Stop: unknown }).Stop, [{ hooks: [] }]);
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
  assert.equal(await installSkillWriteGuardHook(deps, OPTIONS), "registered");
  assert.equal(deps.written.length, 1);
  const rerun = depsWithSettings(deps.written[0]);
  assert.equal(await installSkillWriteGuardHook(rerun, OPTIONS), "unchanged");
  assert.equal(rerun.written.length, 0);
});

test("a dry run reports the change without writing", async () => {
  const deps = depsWithSettings("{}");
  assert.equal(await installSkillWriteGuardHook(deps, { ...OPTIONS, dryRun: true }), "registered");
  assert.equal(deps.written.length, 0);
});

test("unreadable settings are left untouched and reported as an error", async () => {
  for (const text of ["{ not json", "[]"]) {
    const deps = depsWithSettings(text);
    assert.equal(await installSkillWriteGuardHook(deps, OPTIONS), "error");
    assert.equal(deps.written.length, 0);
  }
});
