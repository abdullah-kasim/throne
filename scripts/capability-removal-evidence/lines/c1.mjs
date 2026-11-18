import { GRADE_NAMES, legacyRemovalLeavesNoGradeName, onTheLegacyCommand, LEGACY_FILES } from "./legacy.mjs";
import { COMMITTED_DEFAULT_CONFIG, THRONE_ROOT, compareWithBefore, runCommand } from "../support.mjs";

const SUPERVISOR = "alpha-capremove-01";
const CREATE_AGENT_FILES = ["src/create-agent/create.ts", "src/create-agent/policy.ts", "src/create-agent/resident-agent.ts", "src/create-agent/agent-record.ts", "scripts/capability-removal-evidence/create-agent-court.ts"];
const ROLE_POOL_LINE = /^(Regent|Stager|Alpha|Shadow): (.+) at effort/;
const CREATE_AGENT_ROLES = ["Stager", "Alpha", "Shadow"];
const A_MODEL_NO_COMMITTED_POOL_ADMITS = "sonnet";
const EFFORT_OUTSIDE_EVERY_RANGE = "7";
const EFFORT_ABOVE_GPT_5_5_RANGE = "5";
const PRESET_ADMITTING_GPT_5_5 = "{ alpha: [{ harness: 'codex', model: 'gpt-5.5' }], shadow: [{ harness: 'codex', model: 'gpt-5.5' }], shadowSlice99: [{ harness: 'codex', model: 'gpt-5.5' }] }";

export async function committedRolePools(workspace) {
  const checked = await workspace.throneCli(["check-config"]);
  const pools = [];
  for (const text of checked.stdout.split("\n")) {
    const match = text.match(ROLE_POOL_LINE);
    if (match === null) continue;
    for (const pair of match[2].split(",").map((part) => part.trim())) {
      const [harness, model] = pair.split("/");
      pools.push({ role: match[1], harness, model });
    }
  }
  return pools;
}

export function agentNameFor(role, model, purpose) {
  const prefix = role === "Shadow" ? "shadow" : role === "Alpha" ? "alpha" : "stager";
  return `${prefix}-${purpose}-${model.replaceAll(/[^a-z0-9]/g, "")}`;
}

export function createAgentArguments(role, model, name, extra = []) {
  const supervisor = role === "Shadow" ? SUPERVISOR : "Regent";
  const campaign = role === "Stager" ? [] : ["--non-campaign"];
  return ["--model", model, "--role", role, "--name", name, "--supervisor", supervisor, ...campaign, ...extra];
}

export function launchAnswer(role, model, outcome) {
  return { role, model, code: outcome.code, launch_arguments: outcome.launch_arguments, spawn: outcome.spawn };
}

export function refusalAnswer(ask, outcome) {
  return { ask, code: outcome.code, stderr: outcome.stderr, launched: outcome.launch_arguments.length > 0 };
}

async function removedNamesAreGone(workspace) {
  const found = await runCommand("git", ["-C", THRONE_ROOT, "grep", "-n", "-E", GRADE_NAMES, "--", "src", "scripts", "test"]);
  await workspace.saveText("C1.1-grep.txt", found.stdout);
  const hits = found.stdout.split("\n").filter(Boolean);
  return hits.length === 0
    ? { verdict: "PASS", observed: "git grep over src, scripts and test finds none of the removed names" }
    : { verdict: "FAIL", observed: `${hits.length} hits remain, first: ${hits[0]}` };
}

export async function everyRoleLaunches(workspace, options, lineId = "C1.2") {
  await workspace.useConfig(COMMITTED_DEFAULT_CONFIG);
  const pools = await committedRolePools(workspace);
  const answers = await Promise.all(
    pools.map(async ({ role, harness, model }) => {
      if (role === "Regent") {
        const regent = await workspace.probe("regent-launch.ts");
        return { role, model, harness, code: 0, launch_arguments: [regent.launch_arguments], spawn: null };
      }
      const outcome = await workspace.createAgent(createAgentArguments(role, model, agentNameFor(role, model, "launch")));
      return { harness, ...launchAnswer(role, model, outcome) };
    }),
  );
  await workspace.saveText(`${lineId}-pools.json`, `${JSON.stringify(pools, null, 2)}\n`);
  if (pools.length === 0) return { verdict: "FAIL", observed: "check-config named no role pool", before: null };
  return compareWithBefore(lineId, answers, workspace, options);
}

export async function outOfPoolModelIsRefused(workspace, options, lineId = "C1.3") {
  await workspace.useConfig(COMMITTED_DEFAULT_CONFIG);
  const answers = await Promise.all(
    CREATE_AGENT_ROLES.map(async (role) => {
      const outcome = await workspace.createAgent(createAgentArguments(role, A_MODEL_NO_COMMITTED_POOL_ADMITS, agentNameFor(role, A_MODEL_NO_COMMITTED_POOL_ADMITS, "pool")));
      return { role, ...refusalAnswer(`${role} ${A_MODEL_NO_COMMITTED_POOL_ADMITS}`, outcome) };
    }),
  );
  if (answers.some((answer) => answer.launched || answer.code === 0)) return { verdict: "FAIL", observed: `an out-of-pool model launched: ${JSON.stringify(answers)}`, before: null };
  return compareWithBefore(lineId, answers, workspace, options);
}

export async function outOfRangeEffortIsRefused(workspace, options, lineId = "C1.4") {
  const committed = await import("node:fs/promises").then((fs) => fs.readFile(COMMITTED_DEFAULT_CONFIG, "utf8"));
  await workspace.writeConfig(
    committed.replace("activePlanPresetName: 'OpusOnly',", `activePlanPresetName: 'Evidence',\n    customPlanPresets: { Evidence: ${PRESET_ADMITTING_GPT_5_5} },`).replace(/  ntfy: \{[^}]*\},\n/, ""),
  );
  const cases = [
    { ask: `gpt-5.5 --effort ${EFFORT_ABOVE_GPT_5_5_RANGE}`, model: "gpt-5.5", extra: ["--effort", EFFORT_ABOVE_GPT_5_5_RANGE], refused: true },
    { ask: `gpt-5.5 --effort ${EFFORT_ABOVE_GPT_5_5_RANGE} --bypass-effort`, model: "gpt-5.5", extra: ["--effort", EFFORT_ABOVE_GPT_5_5_RANGE, "--bypass-effort"], refused: false },
    { ask: `gpt-5.5 --effort ${EFFORT_OUTSIDE_EVERY_RANGE}`, model: "gpt-5.5", extra: ["--effort", EFFORT_OUTSIDE_EVERY_RANGE], refused: true },
  ];
  const answers = await Promise.all(
    cases.map(async (effortCase, index) => {
      const outcome = await workspace.createAgent(createAgentArguments("Shadow", effortCase.model, `shadow-effort-0${index + 1}`, effortCase.extra));
      return { ...refusalAnswer(effortCase.ask, outcome), launch_arguments: outcome.launch_arguments, spawn: outcome.spawn, refusal_expected: effortCase.refused };
    }),
  );
  if (answers.some((answer) => answer.refusal_expected && answer.launched)) return { verdict: "FAIL", observed: `an out-of-range effort launched: ${JSON.stringify(answers)}`, before: null };
  return compareWithBefore(lineId, answers, workspace, options);
}

export const lines = [
  { id: "C1.1", run: removedNamesAreGone, restsOn: ["src", "scripts", "test"] },
  { id: "C1.2", run: everyRoleLaunches, restsOn: [...CREATE_AGENT_FILES, "src/regent-state/regent-launch-recipe.ts", "config.user.example.ts"] },
  { id: "C1.3", run: outOfPoolModelIsRefused, restsOn: [...CREATE_AGENT_FILES, "src/harness-routing/policy/admission.ts", "src/shared-policy/plan-role-policy.ts", "config.user.example.ts"] },
  { id: "C1.4", run: outOfRangeEffortIsRefused, restsOn: [...CREATE_AGENT_FILES, "src/harness-routing/policy/steering.ts", "src/create-agent/request-arguments.ts", "src/harness-routing/policy/model-effort-and-equivalents.ts"] },
  { id: "C1.1-legacy", run: legacyRemovalLeavesNoGradeName, restsOn: ["src/create-agent-legacy/", "test/"] },
  { id: "C1.2-legacy", run: onTheLegacyCommand(everyRoleLaunches, "C1.2-legacy"), restsOn: [...LEGACY_FILES, "config.user.example.ts"] },
  { id: "C1.3-legacy", run: onTheLegacyCommand(outOfPoolModelIsRefused, "C1.3-legacy"), restsOn: [...LEGACY_FILES, "src/harness-routing/policy/admission.ts", "config.user.example.ts"] },
  { id: "C1.4-legacy", run: onTheLegacyCommand(outOfRangeEffortIsRefused, "C1.4-legacy"), restsOn: [...LEGACY_FILES, "src/create-agent-legacy/request-arguments.ts", "src/harness-routing/policy/model-effort-and-equivalents.ts"] },
];
