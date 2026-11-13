import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSpecFixture } from "./spec-behaviour-evidence-fixture.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulesFolder = path.join(repositoryRoot, "scripts", "spec-behaviour-evidence");
const distSource = path.join(repositoryRoot, "dist", "src");
const usage = "Usage: bun run build && bun scripts/spec-behaviour-evidence.mjs --log <absolute path of the JSON log> [--only <ID,ID>]\n";

function refuse(message) {
  process.stderr.write(`${usage}spec-behaviour-evidence refused: ${message}\n`);
  process.exit(2);
}

function parseArguments(commandArguments) {
  let log;
  let only;
  for (let index = 0; index < commandArguments.length; index += 1) {
    if (commandArguments[index] === "--log") log = commandArguments[++index];
    else if (commandArguments[index] === "--only") only = commandArguments[++index]?.split(",").map((id) => id.trim());
    else refuse(`unexpected argument "${commandArguments[index]}"`);
  }
  if (log === undefined || !path.isAbsolute(log)) refuse("--log needs an absolute path");
  return { log, only };
}

function isInside(folder, candidate) {
  const relative = path.relative(folder, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function snapshotOf(repository) {
  const status = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: repository, encoding: "utf8" });
  const files = readdirSync(repository, { recursive: true })
    .map(String)
    .filter((file) => file !== ".git" && !file.startsWith(`.git${path.sep}`))
    .sort();
  return JSON.stringify({ status, files });
}

function capture(run) {
  return async (commandName, commandArguments) => {
    let stdout = "";
    let stderr = "";
    const code = await run(commandArguments, {
      environment: process.env,
      throneRegistry: async () => (await import(pathToFileURL(path.join(distSource, "shared-policy", "command-registry.js")).href)).publicCommandNames(),
      writeStdout: (text) => {
        stdout += text;
      },
      writeStderr: (text) => {
        stderr += text;
      },
    });
    return { command: `throne ${commandName} ${commandArguments.join(" ")}`, code, stdout, stderr };
  };
}

const { log, only } = parseArguments(process.argv.slice(2));
const throneHome = await import(pathToFileURL(path.join(distSource, "shared-policy", "throne-home.js")).href);
const liveDataHomes = [throneHome.throneHomeOfThisMachine(), throneHome.resolveThroneHome()];
const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "spec-behaviour-evidence-")));
const dataHome = path.join(scratch, "data-home");
if (liveDataHomes.some((home) => isInside(home, dataHome) || isInside(dataHome, home))) refuse(`the data home ${dataHome} would touch the live one`);
mkdirSync(dataHome);
process.env.THRONE_DATA_HOME = dataHome;

const distModule = (relativePath) => import(pathToFileURL(path.join(distSource, relativePath)).href);
const featureMapModule = await distModule("feature-map/feature-map.js");
const specLocationModule = await distModule("spec-location/spec-location.js");
const runSpecLocation = capture((await distModule("spec-location/run-spec-location.js")).runSpecLocation);
const runFeatureMap = capture(featureMapModule.runFeatureMap);

const context = {
  scratch,
  dataHome,
  specLocation: (commandArguments) => runSpecLocation("spec-location", commandArguments),
  featureMap: (commandArguments) => runFeatureMap("feature-map", commandArguments),
  states: specLocationModule,
  guardPath(candidate) {
    if (!isInside(scratch, candidate)) refuse(`${candidate} is outside the scratch folder ${scratch}`);
    return candidate;
  },
  snapshotOf,
};
context.repositories = await buildSpecFixture(scratch, async (folder, root) => {
  context.guardPath(folder);
  await context.featureMap([folder, "--repository", root]);
});
context.before = Object.fromEntries(Object.entries(context.repositories).map(([name, repository]) => [name, snapshotOf(repository)]));

const modules = await Promise.all(
  readdirSync(modulesFolder)
    .filter((file) => file.endsWith(".mjs"))
    .sort()
    .map((file) => import(pathToFileURL(path.join(modulesFolder, file)).href)),
);
modules.sort((first, second) => Number(first.runsLast === true) - Number(second.runsLast === true));
const lines = [];
for (const evidenceModule of modules) {
  for (const line of await evidenceModule.run(context)) {
    if (only === undefined || only.includes(line.id)) lines.push(line);
  }
}
const summary = {
  pass: lines.filter((line) => line.result === "PASS").length,
  fail: lines.filter((line) => line.result === "FAIL").length,
  notVerified: lines.filter((line) => line.result === "NOT VERIFIED").length,
};
const report = { tool: "spec-behaviour-evidence", scratch, ran: new Date().toISOString(), lines, summary };
mkdirSync(path.dirname(log), { recursive: true });
writeFileSync(log, `${JSON.stringify(report, null, 2)}\n`);
for (const line of lines) process.stdout.write(`${line.result.padEnd(12)} ${line.id}\n`);
process.stdout.write(`pass ${summary.pass}, fail ${summary.fail}, not verified ${summary.notVerified}; log ${log}\n`);
process.exitCode = summary.fail > 0 ? 1 : 0;
