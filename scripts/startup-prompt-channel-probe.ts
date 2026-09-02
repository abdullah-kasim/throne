import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const cli = path.resolve(import.meta.dirname, "..", "bin", "throne-cli");
let commandEnvironment: NodeJS.ProcessEnv = process.env;
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key === undefined || value === undefined || !key.startsWith("--")) {
    throw new Error("expected --source-repo, --model, --trial, and --evidence-dir");
  }
  args.set(key.slice(2), value);
}

function required(name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "") throw new Error(`--${name} is required`);
  return value;
}

function run(commandArgs: string[]): string {
  const result = spawnSync(cli, commandArgs, {
    encoding: "utf8",
    env: commandEnvironment,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${commandArgs[0]} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function hasWedgeRefusal(logs: string): boolean {
  return (
    logs.includes("— full no-op") &&
    /(?:full no-op remains|required.*full no-op|requires a full no-op|outside the throne root and is a full no-op|No-op: this session is outside the throne root)/i.test(
      logs,
    )
  );
}

const sourceRepo = path.resolve(required("source-repo"));
const model = required("model");
const hookCli = args.get("hook-cli");
if (hookCli !== undefined) {
  commandEnvironment = {
    ...process.env,
    CLAUDE_PROJECT_DIR: path.dirname(path.dirname(path.resolve(hookCli))),
  };
}
const trial = Number.parseInt(required("trial"), 10);
const evidenceDir = path.resolve(required("evidence-dir"));
if (!Number.isInteger(trial) || trial < 1) throw new Error("--trial must be a positive integer");

const stamp = Date.now().toString(36);
const modelSlug = model.endsWith("luna") ? "luna" : model.endsWith("sol") ? "sol" : "model";
const name = `agent-snp-${modelSlug}-${trial}-${stamp.slice(-6)}`;
const expected = { verdict: "PROCEEDED", package: "throne", model, trial };
const resultName = "startupnoop-probe-result.json";
const runDir = path.join(evidenceDir, `${modelSlug}-trial-${trial}`);
mkdirSync(runDir, { recursive: true });

let tree = "";
let logs = "";
let outcome = "UNRESOLVED";
try {
  tree = run(["spawn-git-tree", name, "--repo", sourceRepo, "--non-campaign"]);
  if (hookCli !== undefined) {
    writeFileSync(
      path.join(tree, ".claude", "settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "",
                hooks: [{ type: "command", command: `exec ${path.resolve(hookCli)} throne-startup`, timeout: 10 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
  }
  const prompt =
    `Assignment addressed to ${name}: after reading package.json, create ${resultName} ` +
    `in your current cwd with exactly ${JSON.stringify(expected)} followed by a newline. ` +
    "Do not modify any other file. Then report done.";
  run([
    "create-agent", "--model", model, "--effort", "1", "--name", name,
    "--supervisor", "alpha-startupnoop-fix", "--role", "Agent", "--cwd", tree,
    "--prompt", prompt, "--bypass-preset-agent", "--non-campaign",
  ]);

  const resultPath = path.join(tree, resultName);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    logs = run(["agent-logs", name]);
    if (existsSync(resultPath) || hasWedgeRefusal(logs)) break;
    await sleep(500);
  }
  if (existsSync(resultPath)) {
    const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as unknown;
    outcome = JSON.stringify(parsed) === JSON.stringify(expected) ? "PROCEEDED" : "BAD_ARTIFACT";
  } else if (hasWedgeRefusal(logs)) {
    outcome = "WEDGED";
  }
  writeFileSync(path.join(runDir, "agent-logs.txt"), logs);
  writeFileSync(
    path.join(runDir, "summary.json"),
    `${JSON.stringify({ name, sourceRepo, hookCli: hookCli ?? null, model, trial, expected, outcome }, null, 2)}\n`,
  );
  process.stdout.write(`${outcome} ${path.join(runDir, "summary.json")}\n`);
} finally {
  if (tree !== "") {
    const reap = spawnSync(
      cli,
      ["reap-agent", name, "--reason", "scratch", "--force", "--bypass-marker"],
      {
      encoding: "utf8",
      },
    );
    if (reap.status !== 0) process.stderr.write(reap.stderr);
  }
}
