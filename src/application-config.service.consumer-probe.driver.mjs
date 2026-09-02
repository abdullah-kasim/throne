// Subprocess probe for the roleplay-preset proof specs. Spawned by
// `runPersonaConsumerProbe` (application-config.service.consumer-fixture.ts)
// with a fixture cwd as its sole argv entry, BEFORE any sibling module is
// imported. `PERSONA_CONFIG` is a module-level singleton resolved once at
// import time via `resolveLiveThroneRoot()`'s zero-arg call, which is
// anchored to `RUNTIME_THRONE_ROOT` (the running module's own on-disk
// location) unless `THRONE_LIVE_ROOT` is set — it is NOT this chdir that
// steers which fixture `PERSONA_CONFIG` observes; `runPersonaConsumerProbe`
// sets `THRONE_LIVE_ROOT=fixtureCwd` in the spawned child's env for that.
// The chdir below is kept because at least one imported module
// (`derive-shadow-name-from-alpha.command.ts`) reads `process.cwd()` for
// its own unrelated reason; every import below still resolves relative to
// this file's real repo location regardless. Every value below comes from
// calling the REAL exported production functions (or a real production
// function's injectable dependency seam) — nothing here reimplements the
// builders it proves.
const fixtureCwd = process.argv[2];
process.chdir(fixtureCwd);

const { join } = await import("node:path");

const appConfig = await import("./application-config.service.ts");
const identityData = await import("./agentdata/identity-data.service.ts");
const startup = await import(
  "./throne-startup/throne-startup-reconciliation.service.ts"
);
const regentState = await import("./regent-state/regent-state.service.ts");
const notifyLord = await import("./notify-lord/notify-lord.command.ts");
const objectiveContract = await import("./shared-policy/objective-contract.ts");
const deriveShadowName = await import(
  "./derive-shadow-name-from-alpha/derive-shadow-name-from-alpha.command.ts"
);
const config = await import("./config.ts");
const idleFamily = await import("./no-idling/idle-family.ts");
const noIdlingTestFixtures = await import(
  "./no-idling/no-idling-command-test-fixtures.ts"
);

const results = {};

results.personaConfig = appConfig.PERSONA_CONFIG;

const alphaIdentity = { supervisor: "alpha-proof-super", escalation: "Regent", role: "Alpha" };
results.identityText = identityData.identityText("alpha-proof", alphaIdentity);
results.composeOpeningPrompt = identityData.composeOpeningPrompt("alpha-proof", alphaIdentity);
results.roleStandingInstructionAlpha = identityData.roleStandingInstruction("Alpha", "alpha-proof");
results.composeCodexOpeningPrompt = identityData.composeCodexOpeningPrompt("agent-proof", "/ledger/data");
results.roleNameFor = identityData.roleNameFor("shadow", "proof-name");

const fixtureThroneRoot = join(fixtureCwd, "throne-root");
const fixtureRegentDir = join(fixtureCwd, "regent-dir");

// This root is only ever embedded as display text inside the prompts built
// below (buildResumePrompt never touches the filesystem), so it stays
// pinned to the exact literal the PROOF specs assert byte-for-byte.
const displayThroneRoot = "/fixture/throne-root";

results.buildResumePrompt = startup.buildResumePrompt("shadow-proof", displayThroneRoot);

let exactResumePromptCapture = null;
await startup.resumeOrphan("shadow-exact-proof", {
  readSpawnSpec: async () => ({
    harness: "claude",
    model: "sonnet",
    effort: 1,
    cwd: fixtureCwd,
    session_id: "12345678-1234-1234-1234-123456789012",
    spawned_at: new Date(0).toISOString(),
  }),
  resumeRegisteredAgentInRestoredTab: async () => ({ kind: "new-tab-launched" }),
  deliverOpeningPrompt: async (name, prompt) => {
    exactResumePromptCapture = { name, prompt };
  },
  pathExists: async () => true,
  throneRoot: fixtureThroneRoot,
  log: () => {},
  warn: () => {},
});
results.buildExactResumePrompt = exactResumePromptCapture;

let resurrectPromptCapture = null;
await regentState.resurrectRegent({
  startAgent: async () => {},
  deliverOpeningPrompt: async (name, prompt) => {
    resurrectPromptCapture = { name, prompt };
  },
  readRegentHarness: async () => "claude",
  readRegentRoute: async () => undefined,
  findLiveRegent: async () => null,
  writeStderr: () => {},
  throneRoot: fixtureThroneRoot,
  regentDir: fixtureRegentDir,
  spawnMarkerWindowMs: regentState.DEFAULT_SPAWN_MARKER_WINDOW_MS,
});
results.resurrectPrompt = resurrectPromptCapture;

results.lordNotificationTitle = notifyLord.LORD_NOTIFICATION_TITLE;

// Identifier-classification surfaces PROOF #3 exercises. None of these read
// PERSONA_CONFIG — the proof is that their output is unaffected by whichever
// persona config this same process resolved above.
results.canonicalShadowName = objectiveContract.canonicalShadowNameFromAlpha({
  alphaName: "alpha-prf-proof",
  sliceId: "slice-one",
  alphaEvidence: { objective_code: "prf" },
});

let deriveShadowNameStdout = "";
let deriveShadowNameStderr = "";
const deriveShadowNameExitCode = await deriveShadowName.runDeriveShadowName(
  ["alpha-prf-proof", "proof-slice"],
  {
    readAlphaEvidence: async () => ({ objective_code: "prf" }),
    writeStdout: (text) => {
      deriveShadowNameStdout += text;
    },
    writeStderr: (text) => {
      deriveShadowNameStderr += text;
    },
  },
);
results.deriveShadowName = {
  exitCode: deriveShadowNameExitCode,
  stdout: deriveShadowNameStdout,
  stderr: deriveShadowNameStderr,
};

results.classifyPlanRoleAlpha = config.classifyPlanRole("Alpha");
results.classifyPlanRoleShadowSlice99 = config.classifyPlanRole("Shadow", "shadow-prf-99a", "prf");
results.classifyPlanRoleShadowOrdinary = config.classifyPlanRole("Shadow", "shadow-prf-01", "prf");
results.isShadowSlice99Name = config.isShadowSlice99Name("shadow-prf-99a", "prf");

results.findFullyIdleFamilies = idleFamily.findFullyIdleFamilies({
  roster: [
    {
      name: "alpha-prf-proof",
      lifecycle: "live",
      liveStatus: "idle",
      reportLanded: false,
      role: "Alpha",
      focused: false,
    },
    {
      name: "shadow-prf-proof-01",
      lifecycle: "live",
      liveStatus: "idle",
      reportLanded: false,
      role: "Shadow",
      focused: false,
    },
  ],
  supervisors: new Map([
    ["shadow-prf-proof-01", noIdlingTestFixtures.identityFound("alpha-prf-proof")],
  ]),
});

process.stdout.write(JSON.stringify(results));
