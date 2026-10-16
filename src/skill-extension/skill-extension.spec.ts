import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runSkillExtension } from "./skill-extension.ts";

const ORDER_CAKE_EXTENSION = "Before taking the order, check the oven schedule.\n";
const DECORATE_CAKE_EXTENSION = "Ask for the lettering twice.\n";

interface CommandRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function scratchThroneHome(t: TestContext): Promise<string> {
  const throneHome = await mkdtemp(path.join(tmpdir(), "skill-extension-"));
  t.after(() => rm(throneHome, { recursive: true, force: true }));
  return throneHome;
}

async function writeExtension(throneHome: string, fileName: string, content: string): Promise<string> {
  const folder = path.join(throneHome, "skill-extensions");
  await mkdir(folder, { recursive: true });
  const extensionPath = path.join(folder, fileName);
  await writeFile(extensionPath, content);
  return extensionPath;
}

async function runCommand(
  throneHome: string,
  commandArguments: readonly string[],
  stdin = "",
): Promise<CommandRun> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runSkillExtension(commandArguments, {
    environment: { THRONE_DATA_HOME: throneHome },
    readStdin: () => Promise.resolve(stdin),
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
  });
  return { exitCode, stdout, stderr };
}

test("an operator extension for a skill is printed with its path when it exists", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const extensionPath = await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  const run = await runCommand(throneHome, ["order-cake"]);

  assert.deepEqual(run, {
    exitCode: 0,
    stdout: `Operator extension for the order-cake skill, from ${extensionPath}:\n${ORDER_CAKE_EXTENSION}`,
    stderr: "",
  });
});

test("asking for a skill with no extension prints nothing and succeeds", async (t) => {
  const throneHome = await scratchThroneHome(t);
  await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  assert.deepEqual(await runCommand(throneHome, ["decorate-cake"]), { exitCode: 0, stdout: "", stderr: "" });
  assert.deepEqual(await runCommand(await scratchThroneHome(t), ["decorate-cake"]), {
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
});

test("the extensions folder moves with THRONE_DATA_HOME", async (t) => {
  const firstHome = await scratchThroneHome(t);
  const secondHome = await scratchThroneHome(t);
  await writeExtension(firstHome, "order-cake.md", ORDER_CAKE_EXTENSION);
  const secondPath = await writeExtension(secondHome, "order-cake.md", DECORATE_CAKE_EXTENSION);

  const run = await runCommand(secondHome, ["order-cake"]);

  assert.equal(run.stdout, `Operator extension for the order-cake skill, from ${secondPath}:\n${DECORATE_CAKE_EXTENSION}`);
});

test("the extension list names every extension present", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const orderPath = await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);
  const decoratePath = await writeExtension(throneHome, "decorate-cake.md", DECORATE_CAKE_EXTENSION);
  await writeExtension(throneHome, "oven-notes.txt", "Not an extension.\n");

  const run = await runCommand(throneHome, ["--list"]);

  assert.deepEqual(run, {
    exitCode: 0,
    stdout: `decorate-cake: ${decoratePath}\norder-cake: ${orderPath}\n`,
    stderr: "",
  });
});

test("the extension list is empty when there are no extensions", async (t) => {
  const throneHome = await scratchThroneHome(t);

  assert.deepEqual(await runCommand(throneHome, ["--list"]), { exitCode: 0, stdout: "", stderr: "" });
  await mkdir(path.join(throneHome, "skill-extensions"));
  assert.deepEqual(await runCommand(throneHome, ["--list"]), { exitCode: 0, stdout: "", stderr: "" });
});

test("a skill name that would reach outside the extensions folder is refused", async (t) => {
  const throneHome = await scratchThroneHome(t);
  await writeFile(path.join(throneHome, "secret.md"), "Not an extension.\n");

  for (const skillName of ["../secret", "..", ".", "", "bakery/order-cake", "bakery\\order-cake"]) {
    const run = await runCommand(throneHome, [skillName]);
    assert.equal(run.exitCode, 2, skillName);
    assert.equal(run.stdout, "", skillName);
    assert.match(run.stderr, /is not a plain skill name/, skillName);
  }
});

test("an unknown flag or a missing skill name is refused with the usage", async (t) => {
  const throneHome = await scratchThroneHome(t);
  await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  for (const commandArguments of [["--bake"], [], ["order-cake", "decorate-cake"], ["--list", "order-cake"]]) {
    const run = await runCommand(throneHome, commandArguments);
    assert.equal(run.exitCode, 2, commandArguments.join(" "));
    assert.equal(run.stdout, "", commandArguments.join(" "));
    assert.match(run.stderr, /^Usage: throne skill-extension/, commandArguments.join(" "));
  }
});

function skillToolEvent(skillName: string): string {
  return JSON.stringify({
    session_id: "bakery-session",
    hook_event_name: "PreToolUse",
    tool_name: "Skill",
    tool_input: { skill: skillName },
  });
}

function slashCommandEvent(commandName: string): string {
  return JSON.stringify({
    session_id: "bakery-session",
    hook_event_name: "UserPromptExpansion",
    expansion_type: "slash_command",
    command_name: commandName,
    command_args: "",
    prompt: `/${commandName}`,
  });
}

function addedContext(eventName: string, skillName: string, extensionPath: string, content: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: `Operator extension for the ${skillName} skill, from ${extensionPath}:\n${content}`,
    },
  })}\n`;
}

test("loading a skill that has an operator extension hands its text to Claude Code as added context", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const extensionPath = await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  const run = await runCommand(throneHome, ["--hook"], skillToolEvent("order-cake"));

  assert.deepEqual(run, {
    exitCode: 0,
    stdout: addedContext("PreToolUse", "order-cake", extensionPath, ORDER_CAKE_EXTENSION),
    stderr: "",
  });
});

test("typing a skill's slash command hands its operator extension to Claude Code as added context", async (t) => {
  const throneHome = await scratchThroneHome(t);
  const extensionPath = await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  const run = await runCommand(throneHome, ["--hook"], slashCommandEvent("order-cake"));

  assert.deepEqual(run, {
    exitCode: 0,
    stdout: addedContext("UserPromptExpansion", "order-cake", extensionPath, ORDER_CAKE_EXTENSION),
    stderr: "",
  });
});

test("loading a skill with no operator extension adds nothing", async (t) => {
  const throneHome = await scratchThroneHome(t);
  await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);

  for (const hookEvent of [
    skillToolEvent("decorate-cake"),
    slashCommandEvent("decorate-cake"),
    skillToolEvent("bakery:order-cake"),
  ]) {
    assert.deepEqual(await runCommand(throneHome, ["--hook"], hookEvent), { exitCode: 0, stdout: "", stderr: "" });
  }
});

test("a malformed hook event adds nothing and never blocks the skill", async (t) => {
  const throneHome = await scratchThroneHome(t);
  await writeExtension(throneHome, "order-cake.md", ORDER_CAKE_EXTENSION);
  await writeFile(path.join(throneHome, "secret.md"), "Not an extension.\n");

  for (const hookEvent of [
    "",
    "not json",
    "[]",
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { skill: "order-cake" } }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: "order-cake" }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: 42 } }),
    JSON.stringify({ hook_event_name: "SessionStart", command_name: "order-cake" }),
    skillToolEvent("../secret"),
  ]) {
    assert.deepEqual(await runCommand(throneHome, ["--hook"], hookEvent), { exitCode: 0, stdout: "", stderr: "" }, hookEvent);
  }
});
