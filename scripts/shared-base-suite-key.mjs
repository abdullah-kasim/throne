import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isTestGroupEnabled, listedTestGroups } from "../test/heavy-tests-gate.ts";

const NPM_SCRIPT_REFERENCE = /\bnpm (?:test\b|run ([\w:.-]+))/g;
const SOURCE_PATH_TOKEN = /[\w./-]+\.(?:mjs|js|ts)\b/g;
const QUOTED_SOURCE_PATH = /["']([^"'\s*]+\.(?:mjs|js|ts))["']/g;
const DEFAULT_NPM_SCRIPT = "test";

export function readBaseTree(baseDirectory) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: baseDirectory,
    encoding: "utf8",
  }).trim();
}

export function hasUncommittedChanges(baseDirectory) {
  return (
    execFileSync("git", ["status", "--porcelain"], {
      cwd: baseDirectory,
      encoding: "utf8",
    }).trim() !== ""
  );
}

export function readOptInGroups(environment) {
  return listedTestGroups
    .filter((group) => isTestGroupEnabled(group, environment))
    .map((group) => group.environmentVariable);
}

function namedNpmScript(suiteCommand) {
  if (suiteCommand[0] !== "npm") return undefined;
  if (suiteCommand[1] === "test") return DEFAULT_NPM_SCRIPT;
  if (suiteCommand[1] === "run") return suiteCommand[2];
  return undefined;
}

function expandNpmScripts(packageScripts, firstScriptName) {
  const texts = [];
  const pending = firstScriptName ? [firstScriptName] : [];
  const seen = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (seen.has(name) || packageScripts[name] === undefined) continue;
    seen.add(name);
    texts.push(packageScripts[name]);
    for (const reference of packageScripts[name].matchAll(NPM_SCRIPT_REFERENCE)) {
      pending.push(reference[1] ?? DEFAULT_NPM_SCRIPT);
    }
  }
  return texts;
}

function isSourceFileInsideBase(baseDirectory, candidate) {
  const relative = path.relative(baseDirectory, candidate);
  if (relative.startsWith("..") || relative.split(path.sep).includes("node_modules")) return false;
  return existsSync(candidate) && statSync(candidate).isFile();
}

function findReferencedFiles(baseDirectory, file) {
  const directory = path.dirname(file);
  const references = [];
  for (const match of readFileSync(file, "utf8").matchAll(QUOTED_SOURCE_PATH)) {
    const candidate = path.resolve(directory, match[1]);
    if (isSourceFileInsideBase(baseDirectory, candidate)) references.push(candidate);
  }
  return references;
}

export function listSuiteRunningScripts(baseDirectory, suiteCommand) {
  const packageScripts = JSON.parse(readFileSync(path.join(baseDirectory, "package.json"), "utf8")).scripts ?? {};
  const commandTexts = [suiteCommand.join(" "), ...expandNpmScripts(packageScripts, namedNpmScript(suiteCommand))];
  const pending = commandTexts
    .flatMap((text) => [...text.matchAll(SOURCE_PATH_TOKEN)].map((match) => path.resolve(baseDirectory, match[0])))
    .filter((candidate) => isSourceFileInsideBase(baseDirectory, candidate));
  const found = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (found.has(file)) continue;
    found.add(file);
    pending.push(...findReferencedFiles(baseDirectory, file));
  }
  return [...found].map((file) => path.relative(baseDirectory, file)).sort();
}

export function hashFiles(baseDirectory, relativeFiles) {
  const hash = createHash("sha256");
  for (const file of relativeFiles) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(baseDirectory, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function sharedBaseResultKey({ tree, suiteCommand, groups, suiteScriptsHash }) {
  return createHash("sha256")
    .update(JSON.stringify({ tree, suiteCommand, groups, suiteScriptsHash }))
    .digest("hex");
}

export function describeSharedBaseRun(baseDirectory, suiteCommand, environment) {
  const suiteScripts = listSuiteRunningScripts(baseDirectory, suiteCommand);
  return {
    tree: readBaseTree(baseDirectory),
    suiteCommand,
    groups: readOptInGroups(environment),
    suiteScriptsHash: hashFiles(baseDirectory, suiteScripts),
  };
}
