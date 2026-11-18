import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_NAMES, type Harness } from "./harness-identity.ts";
import { MODEL_REGISTRY } from "./model-registry.ts";
import { regentLaunchArgv } from "../regent-state/regent-launch-recipe.ts";
import {
  CODEX_RUNS_TYPED_COMMANDS_WITHOUT_A_LOGIN_SHELL,
  buildLaunchArgv,
  buildResumeArgv,
  launcherFamily,
  type HarnessRequest,
} from "./harness.ts";

test("an unrecognized harness fails loudly instead of silently launching as Claude", () => {
  const bogusHarness = "not-a-real-harness" as Harness;
  assert.throws(
    () => launcherFamily(bogusHarness, "opus"),
    (error: unknown) =>
      error instanceof Error && error.message.includes(bogusHarness),
    "expected launcherFamily to throw naming the unrecognized harness, not resolve it to claudey/claudey-all",
  );
});

const SESSION_NAME_FLAG = "--name";
const HARNESSES_THAT_ARE_NOT_CLAUDE_CODE: readonly HarnessRequest[] = [
  { harness: HARNESS_NAMES.CODEX, model: "gpt-5.5", effort: 2 },
];
const CLAUDE_CODE_LAUNCH: HarnessRequest = {
  harness: HARNESS_NAMES.CLAUDE,
  model: "opus",
  effort: 2,
};

test("a launch request that names no session produces the same arguments as before", () => {
  const launchArguments = buildLaunchArgv(CLAUDE_CODE_LAUNCH);

  assert.deepEqual(launchArguments.slice(1), [
    "--model",
    "opus",
    "--effort",
    "medium",
  ]);
  assert.ok(launchArguments[0]?.endsWith("claudey"));
  for (const request of HARNESSES_THAT_ARE_NOT_CLAUDE_CODE) {
    assert.equal(buildLaunchArgv(request).includes(SESSION_NAME_FLAG), false);
  }
});

test("a session name with a space in it is passed to the harness as one argument", () => {
  const sessionName = `shadow tidy; $HOME "one" it's`;
  const unnamedLaunchArguments = buildLaunchArgv(CLAUDE_CODE_LAUNCH);

  const launchArguments = buildLaunchArgv({
    ...CLAUDE_CODE_LAUNCH,
    sessionName,
  });

  assert.deepEqual(launchArguments, [
    ...unnamedLaunchArguments,
    SESSION_NAME_FLAG,
    sessionName,
  ]);
});

test("a harness that is not Claude Code is launched the same whether or not a session name is given", () => {
  for (const request of HARNESSES_THAT_ARE_NOT_CLAUDE_CODE) {
    assert.deepEqual(
      buildLaunchArgv({ ...request, sessionName: "shadow-tidy-01" }),
      buildLaunchArgv(request),
      `${request.harness} launch changed when a session name was given`,
    );
  }
});

test("a resumed Claude Code session is given its session name again", () => {
  const sessionId = "0f6f2a51-7c1e-4d0b-9a55-3f1f5f0c2b9e";
  const sessionName = "shadow-tidy-01";

  const resumeArguments = buildResumeArgv(
    { ...CLAUDE_CODE_LAUNCH, sessionName },
    sessionId,
  );

  assert.deepEqual(resumeArguments, [
    ...buildLaunchArgv(CLAUDE_CODE_LAUNCH),
    SESSION_NAME_FLAG,
    sessionName,
    "--resume",
    sessionId,
  ]);
  assert.deepEqual(
    buildResumeArgv(CLAUDE_CODE_LAUNCH, sessionId),
    [...buildLaunchArgv(CLAUDE_CODE_LAUNCH), "--resume", sessionId],
  );
  for (const request of HARNESSES_THAT_ARE_NOT_CLAUDE_CODE) {
    assert.deepEqual(
      buildResumeArgv({ ...request, sessionName }, sessionId),
      buildResumeArgv(request, sessionId),
      `${request.harness} resume changed when a session name was given`,
    );
  }
});

function carriesTheSettingInOrder(argv: string[], setting: string[]): boolean {
  return argv.some((_, start) =>
    setting.every((part, offset) => argv[start + offset] === part),
  );
}

test("a Codex agent is launched so its typed commands keep the court's PATH", () => {
  const sessionId = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
  const codexLaunches: HarnessRequest[] = [
    { harness: HARNESS_NAMES.CODEX, model: "gpt-5.5", effort: 2 },
    { harness: HARNESS_NAMES.CODEXY_ALL_OMNI, model: "gpt-5.6-sol", effort: 3 },
  ];
  const everyCodexArgv = [
    ...codexLaunches.flatMap((request) => [
      buildLaunchArgv(request),
      buildResumeArgv(request, sessionId),
    ]),
    regentLaunchArgv(undefined, undefined, HARNESS_NAMES.CODEX),
  ];

  assert.deepEqual(CODEX_RUNS_TYPED_COMMANDS_WITHOUT_A_LOGIN_SHELL, [
    "-c",
    "allow_login_shell=false",
  ]);
  for (const argv of everyCodexArgv) {
    assert.ok(
      carriesTheSettingInOrder(argv, CODEX_RUNS_TYPED_COMMANDS_WITHOUT_A_LOGIN_SHELL),
      argv.join(" "),
    );
  }
  const launchesThatAreNotCodex = [
    CLAUDE_CODE_LAUNCH,
    ...HARNESSES_THAT_ARE_NOT_CLAUDE_CODE.filter(
      (request) => request.harness !== HARNESS_NAMES.CODEX,
    ),
  ];
  for (const request of launchesThatAreNotCodex) {
    assert.equal(
      buildLaunchArgv(request).includes("allow_login_shell=false"),
      false,
      `${request.harness} launch carries a Codex setting`,
    );
  }
});
