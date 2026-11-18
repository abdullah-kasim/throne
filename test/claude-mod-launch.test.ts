import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CLAUDE_MOD_FOLDER,
  claudeModMisfit,
  claudeModMisfitRemembered,
  decideClaudeModLaunch,
  type ClaudeModLaunchDecision,
  type ClaudeModLaunchDeps,
} from "../src/herdr/claude-mod-route.ts";
import type { StartInTabDeps } from "../src/herdr/herdr-create.contracts.ts";
import { startInTab } from "../src/herdr/herdr-launch.ts";

function scratchFolder(): string {
  const root = path.join(os.homedir(), "tmp");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "claude-mod-launch-test-"));
}

function executable(folder: string, name: string, body: string): string {
  const file = path.join(folder, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

interface Launch {
  readonly script: string;
  readonly recorded: [string, boolean][];
  readonly warnings: string[];
  readonly decided: number;
}

async function launch(
  argv: string[],
  detectedKind: string,
  decision: ClaudeModLaunchDecision | undefined,
): Promise<Launch> {
  const binaries = scratchFolder();
  executable(binaries, "claude", "exit 0");
  executable(binaries, "codex", "exit 0");
  const calls: string[][] = [];
  const recorded: [string, boolean][] = [];
  const warnings: string[] = [];
  let decided = 0;
  const claudeMod: ClaudeModLaunchDeps | undefined =
    decision === undefined
      ? undefined
      : {
          decide: () => {
            decided += 1;
            return decision;
          },
          record: async (name, loaded) => {
            recorded.push([name, loaded]);
          },
          warn: (line) => warnings.push(line),
        };
  const deps: StartInTabDeps = {
    runHerdr: (async (args: string[]) => {
      calls.push(args);
      if (args[0] === "agent" && args[1] === "list") {
        return {
          stdout: JSON.stringify({
            result: { agents: [{ agent: detectedKind, terminal_id: "t", pane_id: "pane-1", name: "agent-name" }] },
          }),
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    }) as StartInTabDeps["runHerdr"],
    now: () => 0,
    sleep: async () => undefined,
    vendoredHarnessBinaryDirectory: binaries,
    ...(claudeMod === undefined ? {} : { claudeMod }),
  };
  await startInTab("agent-name", "pane-1", { argv }, deps);
  const typed = calls.find((call) => call[0] === "pane" && call[1] === "send-text")![3]!;
  const scriptPath = typed.match(/^ bash '([^']+)'$/u)![1]!;
  return { script: readFileSync(scriptPath, "utf8"), recorded, warnings, decided };
}

test("a Claude agent is launched with the mod folder and spawn.json records it", async () => {
  const launched = await launch(["claude", "--model", "opus"], "claude", decideClaudeModLaunch(() => undefined));
  assert.match(launched.script, new RegExp(`'--plugin-dir' '${CLAUDE_MOD_FOLDER}'`, "u"));
  assert.deepEqual(launched.recorded, [["agent-name", true]]);
  assert.deepEqual(launched.warnings, []);
});

test("a mod that does not fit this Claude Code version is left out, one clear line says so, and the agent still launches", async () => {
  const launched = await launch(
    ["claude"],
    "claude",
    decideClaudeModLaunch(() => "claude plugin validate failed: unknown hook"),
  );
  assert.doesNotMatch(launched.script, /--plugin-dir/u);
  assert.equal(launched.warnings.length, 1);
  assert.match(launched.warnings[0]!, /does not fit this Claude Code version.*"agent-name".*unknown hook/u);
  assert.deepEqual(launched.recorded, [["agent-name", false]]);
});

test("Codex agents are launched exactly as before", async () => {
  const launched = await launch(["codex", "-m", "gpt-5.6-sol"], "codex", { load: true });
  assert.equal(launched.decided, 0);
  assert.doesNotMatch(launched.script, /--plugin-dir/u);
  assert.deepEqual(launched.recorded, []);
});

test("the mod fits only when claude plugin validate passes on the installed build", () => {
  const folder = scratchFolder();
  const passing = executable(folder, "claude-pass", "exit 0");
  const failing = executable(folder, "claude-fail", 'echo "hook turn.start is unknown" >&2; exit 1');
  assert.equal(claudeModMisfit(passing, folder), undefined);
  assert.match(claudeModMisfit(failing, folder)!, /validate failed: hook turn.start is unknown/u);
  assert.match(claudeModMisfit(passing, path.join(folder, "absent"))!, /missing/u);
});

test("a passing validate is remembered per Claude Code version and mod content, a failing one never", () => {
  const folder = scratchFolder();
  const mod = path.join(folder, "mod");
  mkdirSync(mod);
  writeFileSync(path.join(mod, "hooks.json"), "{}");
  const claudePackage = path.join(folder, "claude-code");
  mkdirSync(path.join(claudePackage, "bin"), { recursive: true });
  const setVersion = (version: string) =>
    writeFileSync(path.join(claudePackage, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version }));
  const calls = path.join(folder, "calls");
  const claude = executable(path.join(claudePackage, "bin"), "claude", `echo x >> '${calls}'; exit "\$(cat '${folder}/exit-code' 2>/dev/null || echo 0)"`);
  const fitFile = path.join(folder, "cache", "claude-mod-fit.txt");
  const validations = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).length;
  setVersion("2.1.326");
  assert.equal(claudeModMisfitRemembered(claude, mod, fitFile), undefined);
  assert.equal(claudeModMisfitRemembered(claude, mod, fitFile), undefined);
  assert.equal(validations(), 1);
  writeFileSync(path.join(mod, "hooks.json"), '{"changed":true}');
  assert.equal(claudeModMisfitRemembered(claude, mod, fitFile), undefined);
  assert.equal(validations(), 2);
  setVersion("2.1.327");
  writeFileSync(path.join(folder, "exit-code"), "1");
  assert.match(claudeModMisfitRemembered(claude, mod, fitFile)!, /validate failed/u);
  assert.match(claudeModMisfitRemembered(claude, mod, fitFile)!, /validate failed/u);
  assert.equal(validations(), 4);
});
