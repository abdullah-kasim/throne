import { THRONE_ROOT, comparableSpawnRecord, runCommand } from "../support.mjs";

export const LEGACY_FILES = ["src/create-agent-legacy/create.ts", "src/create-agent-legacy/policy.ts", "src/create-agent-legacy/legacy-model-steering.ts", "src/create-agent-legacy/legacy-capabilities.ts", "scripts/capability-removal-evidence/create-agent-legacy-court.ts"];
const GRADE_NAME_PARTS = [["PLANNING", "_FLOOR"], ["VALIDATION", "_FLOOR"], ["non", "Coding"], ["modelClears", "PlanningFloor"], ["modelClears", "ValidationFloor"], ["highest", "CapabilityModel"], ["highest", "ValidationModel"], ["parseCapability", "Requirements"], ["thinkingRole", "CapabilityGuard"], ["evaluateFinal", "Capability"], ["Capability", "Evidence"], ["Capability", "Requirement"], ["Model", "Capabilities"], ["derive", "CapabilityTables"]];
export const GRADE_NAMES = GRADE_NAME_PARTS.map((parts) => parts.join("")).join("|");
const LEGACY_FOLDER = "src/create-agent-legacy";
const LEGACY_IMPORT = "create-agent-legacy/";
const SECONDS_ONE_SPEC_FILE_MAY_TAKE = 10;

async function filesUsingTheLegacyCopy(root = THRONE_ROOT) {
  const listed = await runCommand("git", ["-C", root, "grep", "-l", "-F", LEGACY_IMPORT, "--", "src", "scripts", "test"]);
  return [LEGACY_FOLDER, ...listed.stdout.split("\n").filter((file) => file !== "" && !file.startsWith(LEGACY_FOLDER))];
}

export async function gradeNamesInTheLegacyCopy(root = THRONE_ROOT) {
  const files = await filesUsingTheLegacyCopy(root);
  const found = await runCommand("git", ["-C", root, "grep", "-n", "-E", GRADE_NAMES, "--", ...files]);
  return { files, found };
}

export async function legacyRemovalLeavesNoGradeName(workspace) {
  const { files, found } = await gradeNamesInTheLegacyCopy();
  await workspace.saveText("C1.1-legacy-grep.txt", found.stdout);
  return found.stdout.trim() === ""
    ? { verdict: "PASS", observed: `no grade name in ${files.length} paths that make up or use the legacy copy`, before: null }
    : { verdict: "FAIL", observed: `grade names remain:\n${found.stdout}`, before: null };
}

export function onTheLegacyCommand(lineRun, lineId) {
  return (workspace, options) =>
    lineRun(
      {
        ...workspace,
        async createAgent(argumentsList) {
          const outcome = await workspace.probe("create-agent-legacy-court.ts", [...argumentsList, "--cwd", workspace.agentCwd]);
          return { ...outcome, spawn: comparableSpawnRecord(outcome.spawn) };
        },
      },
      options,
      lineId,
    );
}

export async function legacySpecsPass(workspace) {
  const files = (await filesUsingTheLegacyCopy()).filter((file) => /\.(test|spec)\.ts$/.test(file));
  const ran = await runCommand(process.execPath, ["test", "--timeout", String(SECONDS_ONE_SPEC_FILE_MAY_TAKE * 1000), ...files.map((file) => `./${file}`)], { env: workspace.environment(), cwd: THRONE_ROOT });
  await workspace.saveText("C4.3-specs.txt", `${ran.stdout}\n${ran.stderr}`);
  const summary = ran.stderr.split("\n").filter((text) => /^\s*\d+ (pass|fail)/.test(text)).join("; ");
  return ran.code === 0
    ? { verdict: "PASS", observed: `${files.length} spec files that use the legacy copy pass: ${summary}`, before: null }
    : { verdict: "FAIL", observed: `legacy specs failed: ${summary}`, before: null, error: ran.stderr.slice(-4000) };
}
