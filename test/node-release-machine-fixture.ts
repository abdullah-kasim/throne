import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import type {
  ProcessOptions,
  ProcessResult,
  ProcessRunner,
} from "../src/forge/forge-dependencies.ts";

export interface RecordedProcess {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ProcessOptions;
}

export interface NodeReleaseMachine {
  readonly root: string;
  readonly installed: string[];
  readonly available: readonly string[];
  readonly newestLts: string;
  readonly globalMiseConfig: string;
  readonly processes: RecordedProcess[];
  npmRefusal?: string;
}

const IDIOMATIC_VERSION_FILES = [".nvmrc", ".node-version"];
const TOOL_VERSIONS_FILE = ".tool-versions";
const NODE_TOOL_LINE = /^node\s+(\S+)/m;

function succeeded(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failed(stderr: string): ProcessResult {
  return { exitCode: 1, stdout: "", stderr };
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function declarationIn(
  directory: string,
  idiomaticFilesEnabled: boolean,
): Promise<{ requested: string; sourceFile: string } | null> {
  const toolVersionsFile = path.join(directory, TOOL_VERSIONS_FILE);
  const toolVersions = await readIfPresent(toolVersionsFile);
  const toolVersionsNode = toolVersions && NODE_TOOL_LINE.exec(toolVersions);
  if (toolVersionsNode) {
    return { requested: toolVersionsNode[1], sourceFile: toolVersionsFile };
  }
  for (const name of idiomaticFilesEnabled ? IDIOMATIC_VERSION_FILES : []) {
    const sourceFile = path.join(directory, name);
    const requested = (await readIfPresent(sourceFile))?.trim();
    if (requested) return { requested, sourceFile };
  }
  return null;
}

function resolvedByMise(
  machine: NodeReleaseMachine,
  requested: string,
): string {
  if (requested === "lts/krypton" || requested === "lts") {
    return semver.maxSatisfying(machine.installed, "24") ?? requested;
  }
  return semver.valid(requested) ?? requested;
}

async function currentNode(
  machine: NodeReleaseMachine,
  options: ProcessOptions,
): Promise<ProcessResult> {
  const idiomaticFilesEnabled =
    options.environment?.MISE_IDIOMATIC_VERSION_FILE_ENABLE_TOOLS === "node";
  for (
    let directory = options.cwd;
    directory !== path.dirname(directory);
    directory = path.dirname(directory)
  ) {
    const found = await declarationIn(directory, idiomaticFilesEnabled);
    if (found) {
      return succeeded(
        JSON.stringify([
          {
            version: resolvedByMise(machine, found.requested),
            requested_version: found.requested,
            source: { type: "idiomatic-version-file", path: found.sourceFile },
          },
        ]),
      );
    }
  }
  return succeeded(
    JSON.stringify([
      {
        version: resolvedByMise(machine, "lts"),
        requested_version: "lts",
        source: { type: "mise.toml", path: machine.globalMiseConfig },
      },
    ]),
  );
}

function installDirectory(
  machine: NodeReleaseMachine,
  version: string,
): string {
  return path.join(machine.root, "installs", "node", version);
}

async function runMise(
  machine: NodeReleaseMachine,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const [command, ...rest] = args;
  const requestedVersion = rest[0]?.replace(/^node@/, "") ?? "";
  if (command === "ls" && rest.includes("--current")) {
    return currentNode(machine, options);
  }
  if (command === "ls" && rest.includes("--installed")) {
    return succeeded(
      JSON.stringify(machine.installed.map((version) => ({ version }))),
    );
  }
  if (command === "ls-remote") return succeeded(machine.available.join("\n"));
  if (command === "latest") return succeeded(`${machine.newestLts}\n`);
  if (command === "install") {
    machine.installed.push(requestedVersion);
    return succeeded("");
  }
  if (command === "where" && machine.installed.includes(requestedVersion)) {
    return succeeded(`${installDirectory(machine, requestedVersion)}\n`);
  }
  return failed(`mise ERROR unexpected call: mise ${args.join(" ")}`);
}

async function runNpm(
  machine: NodeReleaseMachine,
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (machine.npmRefusal !== undefined) return failed(machine.npmRefusal);
  const nodeModules = path.join(options.cwd, "node_modules");
  await access(nodeModules).catch(() => mkdir(nodeModules));
  return succeeded("");
}

export function nodeReleaseMachine(
  root: string,
  installed: readonly string[],
  available: readonly string[] = installed,
): NodeReleaseMachine {
  return {
    root,
    installed: [...installed],
    available,
    newestLts: "24.21.0",
    globalMiseConfig: path.join(root, "global-config", "mise", "config.toml"),
    processes: [],
  };
}

export function machineProcessRunner(
  machine: NodeReleaseMachine,
): ProcessRunner {
  return async (file, args, options) => {
    machine.processes.push({ file, args, options });
    if (file === "mise") return runMise(machine, args, options);
    if (file === "npm") return runNpm(machine, options);
    return failed(`${file}: command not found`);
  };
}

export function machineBinDirectory(
  machine: NodeReleaseMachine,
  version: string,
): string {
  return path.join(installDirectory(machine, version), "bin");
}
