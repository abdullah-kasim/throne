import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeToolInput, createHookBridge, type HookListEntry } from "./throne-pi-hooks.ts";

function throneWithScripts(scripts: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-hooks-"));
  mkdirSync(path.join(root, "claude-hooks"));
  for (const [name, body] of Object.entries(scripts)) writeFileSync(path.join(root, "claude-hooks", name), body);
  return root;
}

function bridge(root: string, hookList: HookListEntry[], logged: string[] = []) {
  return createHookBridge({ throneRoot: root, hookList, log: (line) => logged.push(line), scriptArguments: () => [] });
}

const denyScript = `import json, sys
payload = json.load(sys.stdin)
print(json.dumps({"hookSpecificOutput": {"permissionDecision": "deny", "permissionDecisionReason": "no " + payload["tool_input"]["command"]}}))
`;

describe("the pi hook bridge", () => {
  it("a hook that denies a pi bash call blocks it with the hook's reason", async () => {
    const root = throneWithScripts({ "deny.py": denyScript });
    const answers = await bridge(root, [{ script: "deny.py", event: "PreToolUse", matcher: "Bash" }])("tool_call", {
      tool_name: "Bash",
      tool_input: { command: "touch /tmp/x" },
    });
    assert.deepEqual(answers, [{ block: true, reason: "no touch /tmp/x" }]);
  });

  it("a hook that exits 2 blocks the call with its error output", async () => {
    const root = throneWithScripts({ "two.py": "import sys\nsys.stderr.write('stop here')\nsys.exit(2)\n" });
    const answers = await bridge(root, [{ script: "two.py", event: "PreToolUse" }])("tool_call", { tool_name: "Bash" });
    assert.deepEqual(answers, [{ block: true, reason: "stop here" }]);
  });

  it("a hook's additional context becomes text appended to the pi result", async () => {
    const root = throneWithScripts({
      "note.py": `import json\nprint(json.dumps({"hookSpecificOutput": {"additionalContext": "remember this"}}))\n`,
    });
    const answers = await bridge(root, [{ script: "note.py", event: "PostToolUse", matcher: "Edit|Write" }])("tool_result", {
      tool_name: "Write",
    });
    assert.deepEqual(answers, [{ appendedText: "remember this" }]);
  });

  it("a hook script sees the pi harness in its environment", async () => {
    const root = throneWithScripts({
      "harness.py": `import json, os\nprint(json.dumps({"hookSpecificOutput": {"additionalContext": os.environ.get("THRONE_HOOK_HARNESS", "")}}))\n`,
    });
    const answers = await bridge(root, [{ script: "harness.py", event: "PostToolUse" }])("tool_result", { tool_name: "Bash" });
    assert.deepEqual(answers, [{ appendedText: "pi" }]);
  });

  it("a crashing hook lets the pi call through and logs it", async () => {
    const root = throneWithScripts({ "crash.py": "raise SystemExit(1)\n" });
    const logged: string[] = [];
    const answers = await bridge(root, [{ script: "crash.py", event: "PreToolUse" }], logged)("tool_call", { tool_name: "Bash" });
    assert.deepEqual(answers, []);
    assert.match(logged.join("\n"), /crash\.py: crashed \(exit 1\)/);
  });

  it("a missing hook script lets the pi call through and logs it", async () => {
    const root = throneWithScripts({});
    const logged: string[] = [];
    const answers = await bridge(root, [{ script: "gone.py", event: "PreToolUse" }], logged)("tool_call", { tool_name: "Bash" });
    assert.deepEqual(answers, []);
    assert.match(logged.join("\n"), /gone\.py: script is missing/);
  });

  it("a hook marked not on pi never runs on pi", async () => {
    const root = throneWithScripts({ "deny.py": denyScript });
    const answers = await bridge(root, [{ script: "deny.py", event: "PreToolUse", notOn: ["pi"] }])("tool_call", {
      tool_name: "Bash",
      tool_input: { command: "x" },
    });
    assert.deepEqual(answers, []);
  });

  it("a hook whose event pi lacks writes one log line and never runs", async () => {
    const root = throneWithScripts({ "deny.py": denyScript });
    const logged: string[] = [];
    bridge(root, [{ script: "deny.py", event: "Stop" }], logged);
    assert.deepEqual(logged, ["deny.py: Stop has no pi event, so it does not run on pi"]);
  });

  it("a hook whose matcher names another tool does not run", async () => {
    const root = throneWithScripts({ "deny.py": denyScript });
    const answers = await bridge(root, [{ script: "deny.py", event: "PreToolUse", matcher: "Read" }])("tool_call", {
      tool_name: "Bash",
      tool_input: { command: "x" },
    });
    assert.deepEqual(answers, []);
  });

  it("pi's path argument reaches a hook as file_path", () => {
    assert.deepEqual(claudeToolInput({ path: "/a/SKILL.md", content: "x" }), { path: "/a/SKILL.md", file_path: "/a/SKILL.md", content: "x" });
  });

  it("a submitted pi prompt runs the prompt-submit hooks and waits for them", async () => {
    const root = throneWithScripts({
      "prompt.py": `import json, sys, time\npayload = json.load(sys.stdin)\ntime.sleep(0.3)\nprint(json.dumps({"hookSpecificOutput": {"additionalContext": payload["hook_event_name"] + " " + payload["prompt"]}}))\n`,
    });
    const answers = await bridge(root, [{ script: "prompt.py", event: "UserPromptSubmit" }])("before_agent_start", { prompt: "go on" });
    assert.deepEqual(answers, [{ appendedText: "UserPromptSubmit go on" }]);
  });
});
