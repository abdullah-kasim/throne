import type { ExecutableEntranceEvidence } from "./entrance-steering-coverage.ts";
import batchAEvidence from "./entrance-steering-evidence-batch-a.json" with {
  type: "json",
};
import batchBEvidence from "./entrance-steering-evidence-batch-b.json" with {
  type: "json",
};

const SWITCH_TEST =
  "switch-agent-model real runtime catch steers unknown, missing, and invalid parser refusals before effects";
const SWITCH_BASE = {
  commandName: "switch-agent-model",
  testFile:
    "src/switch-agent-model/switch-agent-model.command-contract.spec.ts",
  testName: SWITCH_TEST,
  sourceFile:
    "src/switch-agent-model/switch-agent-model.command-runtime.ts",
  sourceAnchor:
    'renderFrameworkEntranceRefusal("switch-agent-model", diagnostic, {',
  bypassAssertionTokens: ["No bypass is available for this refusal"],
  humanRouteAssertionTokens: [
    "Ask your supervisor for an allowed alternative invocation",
  ],
  statusAssertionTokens: ["assert.equal(await run(args, fixture.deps), 1)"],
  noEffectAssertionTokens: ["assert.equal(calls, 0)"],
} as const;

const FRAMEWORK_UNKNOWN_OPTION_BASE = {
  failureMode: "unknown flag",
  testFile:
    "src/command-registry-coverage/framework-entrance-steering.test.ts",
  sourceFile: "src/application.ts",
  sourceAnchor: "configureFrameworkSteeredChildParser(runner, argv[2]);",
  invocationTokens: [
    "captureFrameworkRefusal(",
    '"--definitely-unknown"',
  ],
  reasonAssertionTokens: ["unknown option '--definitely-unknown'"],
  bypassAssertionTokens: ["No bypass is available for this refusal"],
  humanRouteAssertionTokens: [
    "Ask your supervisor for an allowed alternative invocation",
  ],
  statusAssertionTokens: ["assert.equal(code, 1)"],
  noEffectAssertionTokens: ["assert.equal(effects, 0)"],
} as const;

export const ENTRANCE_STEERING_EXECUTABLE_EVIDENCE: readonly ExecutableEntranceEvidence[] = [
  {
    commandName: "assert-herdr",
    failureMode: "policy refusal",
    testFile: "src/assert-herdr/assert-herdr.command.test.ts",
    testName: "both presence outcomes emit the exact bytes, stream, and status",
    sourceFile: "src/assert-herdr/assert-herdr.command.ts",
    sourceAnchor: "herdrPreflightOutcome",
    invocationTokens: ["runNestAssertHerdr({", "herdrSessionPresent"],
    reasonAssertionTokens: ["Not running inside a herdr session"],
    bypassAssertionTokens: ["No bypass is available for this refusal"],
    humanRouteAssertionTokens: ["Ask your supervisor to relaunch this harness under herdr"],
    statusAssertionTokens: ["assert.equal(result.status, 1)"],
    noEffectAssertionTokens: ["assert.equal(result.presenceChecks, 1)"],
  },
  {
    commandName: "keep-going",
    failureMode: "missing argument",
    testFile: "src/keep-going/keep-going-entrance-steering.test.ts",
    testName:
      "keep-going real Nest invocation steers a missing transport value before sweep effects",
    sourceFile: "src/application.ts",
    sourceAnchor: "writeFrameworkEntranceRefusal(argv[2]!, error)",
    invocationTokens: [
      '"keep-going", "--transport"',
      "runNestCommanderApplication(",
    ],
    reasonAssertionTokens: ["--transport needs a value"],
    bypassAssertionTokens: ["No bypass is available for this refusal"],
    humanRouteAssertionTokens: [
      "Ask your supervisor for an allowed alternative invocation",
    ],
    statusAssertionTokens: ["assert.equal(code, 1)"],
    noEffectAssertionTokens: ["assert.equal(effects, 0)"],
  },
  {
    ...FRAMEWORK_UNKNOWN_OPTION_BASE,
    commandName: "migrate-queue-markdown",
    testName:
      "migrate-queue-markdown real Nest invocation steers an unknown flag before effects",
  },
  {
    ...FRAMEWORK_UNKNOWN_OPTION_BASE,
    commandName: "consume-fence-handoff-on-start",
    testName:
      "consume-fence-handoff-on-start real Nest invocation steers an unknown flag before effects",
  },
  {
    ...SWITCH_BASE,
    failureMode: "unknown flag",
    invocationTokens: ['args: ["--unknown"]'],
    reasonAssertionTokens: ['unknown argument "--unknown"'],
  },
  {
    ...SWITCH_BASE,
    failureMode: "missing argument",
    invocationTokens: ["args: []"],
    reasonAssertionTokens: ["missing <agent>"],
  },
  {
    ...SWITCH_BASE,
    failureMode: "invalid value",
    invocationTokens: ['"--effort", "7"'],
    reasonAssertionTokens: ["--effort must be an integer 1-6"],
  },
  {
    commandName: "switch-persona",
    failureMode: "invalid value",
    testFile: "src/switch-persona/switch-persona.service.spec.ts",
    testName:
      "runSwitchPersona: rejects an unknown preset loudly, naming the valid set, and never falls back to Default",
    sourceFile: "src/switch-persona/switch-persona.service.ts",
    sourceAnchor: "renderEntranceRefusal({",
    invocationTokens: ["runSwitchPersona(['Nonexistent'], deps)"],
    reasonAssertionTokens: ['Unknown roleplay preset "Nonexistent"'],
    bypassAssertionTokens: ["No bypass is available for this refusal"],
    humanRouteAssertionTokens: [
      "Ask your supervisor for an allowed persona or alternative invocation",
    ],
    statusAssertionTokens: ["assert.equal(code, 1)"],
    noEffectAssertionTokens: ["assert.equal(effects, 0)"],
  },
  {
    commandName: "lint-queue-plan",
    failureMode: "missing argument",
    testFile: "src/lint-queue-plan/lint-queue-plan.command.test.ts",
    testName: "entrance refusal on malformed invocations, before any read",
    sourceFile: "src/lint-queue-plan/lint-queue-plan.command.ts",
    sourceAnchor: "renderEntranceRefusal({",
    invocationTokens: ["runLintQueuePlan(params, dependencies)"],
    reasonAssertionTokens: ["requires exactly one subject"],
    bypassAssertionTokens: ["No bypass is available"],
    humanRouteAssertionTokens: ["Ask your supervisor"],
    statusAssertionTokens: ["assert.equal(code, 1"],
    noEffectAssertionTokens: ["assert.equal(reads, 0"],
  },
  ...(batchAEvidence as unknown as readonly ExecutableEntranceEvidence[]),
  ...(batchBEvidence as unknown as readonly ExecutableEntranceEvidence[]),
];
