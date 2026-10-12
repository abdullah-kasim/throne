import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  hydrateDependencies,
  NpmInstallPlatform,
  type DependencyHydrationResult,
} from "../src/git-lifecycle/dependency-hydration.ts";
import { git } from "./git-repo-test-fixture.ts";
import {
  machineBinDirectory,
  machineProcessRunner,
  nodeReleaseMachine,
  type NodeReleaseMachine,
  type RecordedProcess,
} from "./node-release-machine-fixture.ts";

const INSTALLED = ["20.20.0", "22.21.1", "24.19.0"];
const AVAILABLE = [...INSTALLED, "22.22.0", "24.21.0", "25.1.0", "26.11.1"];
const THRONE_LTS_PIN = "24.19.0";

const scratchParent = await mkdtemp(
  path.join(tmpdir(), "throne-node-per-project-"),
);

after(() => rm(scratchParent, { recursive: true, force: true }));

interface DivergentTrees {
  readonly root: string;
  readonly source: string;
  readonly destination: string;
}

async function writeProject(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(directory, name), content),
    ),
  );
}

async function divergentTrees(
  destinationFiles: Readonly<Record<string, string>> = {},
  sourceFiles: Readonly<Record<string, string>> = {},
): Promise<DivergentTrees> {
  const root = await mkdtemp(path.join(scratchParent, "trees-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await writeProject(source, {
    "package.json": '{"name":"source"}\n',
    ...sourceFiles,
  });
  await writeProject(destination, {
    "package.json": '{"name":"destination"}\n',
    ...destinationFiles,
  });
  await git(destination, ["init"]);
  return { root, source, destination };
}

async function hydrateWithMachine(
  trees: DivergentTrees,
  machine: NodeReleaseMachine,
  thronePin: string = THRONE_LTS_PIN,
): Promise<DependencyHydrationResult> {
  const throneRoot = path.join(trees.root, "throne");
  await mkdir(throneRoot, { recursive: true });
  await writeFile(
    path.join(throneRoot, "mise.toml"),
    `[tools]\nnode = "${thronePin}"\n`,
  );
  return hydrateDependencies(
    trees.source,
    trees.destination,
    undefined,
    undefined,
    new NpmInstallPlatform(machineProcessRunner(machine), throneRoot),
  );
}

function machineFor(
  trees: DivergentTrees,
  installed: readonly string[] = INSTALLED,
): NodeReleaseMachine {
  return nodeReleaseMachine(trees.root, installed, AVAILABLE);
}

function npmProcesses(machine: NodeReleaseMachine): readonly RecordedProcess[] {
  return machine.processes.filter((process) => process.file === "npm");
}

function installPathEntries(machine: NodeReleaseMachine): readonly string[] {
  const [npm] = npmProcesses(machine);
  return (npm.options.environment?.PATH ?? "").split(path.delimiter);
}

test("a project whose .nvmrc says lts/krypton installs its dependencies with Node 24", async () => {
  const trees = await divergentTrees({ ".nvmrc": "lts/krypton\n" });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "24.19.0");
  assert.equal(result.node?.decidedBy, "declared");
  assert.equal(
    installPathEntries(machine)[0],
    machineBinDirectory(machine, "24.19.0"),
  );
});

test("a project whose .node-version pins 22.21.1 installs with exactly 22.21.1", async () => {
  const trees = await divergentTrees({ ".node-version": "22.21.1\n" });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "22.21.1");
  assert.match(result.node?.reason ?? "", /pins Node 22\.21\.1 exactly/);
});

test("a project whose .tool-versions pins node installs with that version", async () => {
  const trees = await divergentTrees({ ".tool-versions": "node 20.20.0\n" });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "20.20.0");
  assert.equal(result.node?.declared, "20.20.0");
});

test("a project that declares only engines installs with the newest LTS release that satisfies it", async () => {
  const trees = await divergentTrees({
    "package.json": '{"name":"destination","engines":{"node":"^22.0.0"}}\n',
  });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "22.21.1");
  assert.equal(result.node?.decidedBy, "engines");
});

test("engines of >=22 picks the newest LTS release, not a newer current release that is installed", async () => {
  const trees = await divergentTrees({
    "package.json": '{"name":"destination","engines":{"node":">=22"}}\n',
  });
  const machine = machineFor(trees, [...INSTALLED, "25.1.0", "26.11.1"]);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "24.19.0");
});

test("an exact pin is honoured even when it is not an LTS release", async () => {
  const trees = await divergentTrees({ ".node-version": "25.1.0\n" });
  const machine = machineFor(trees, [...INSTALLED, "25.1.0"]);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "25.1.0");
});

test("a range that no LTS release satisfies uses the newest release that does and says no LTS satisfies it", async () => {
  const trees = await divergentTrees({
    "package.json": '{"name":"destination","engines":{"node":">=25"}}\n',
  });
  const machine = machineFor(trees, ["24.19.0", "25.1.0"]);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "25.1.0");
  assert.match(result.node?.reason ?? "", /no LTS satisfies >=25/);
});

test("the reason says LTS when the LTS rule chose the version", async () => {
  const trees = await divergentTrees({ ".nvmrc": ">=22\n" });
  const machine = machineFor(trees, [...INSTALLED, "25.1.0"]);

  const result = await hydrateWithMachine(trees, machine);

  assert.equal(result.node?.version, "24.19.0");
  assert.match(
    result.node?.reason ?? "",
    /24\.19\.0 is the newest LTS release satisfying >=22/,
  );
});

test("a project that declares nothing installs with the throne's pinned Node", async () => {
  const trees = await divergentTrees();
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine, "22.21.1");

  assert.equal(result.node?.version, "22.21.1");
  assert.equal(result.node?.decidedBy, "throne pin");
  assert.equal(result.node?.declared, null);
});

test("a throne pin that is not an LTS line falls back to the newest LTS and says so", async () => {
  const trees = await divergentTrees();
  const machine = machineFor(trees, [...INSTALLED, "25.1.0"]);

  const result = await hydrateWithMachine(trees, machine, "25.1.0");

  assert.equal(result.node?.version, "24.19.0");
  assert.match(
    result.node?.reason ?? "",
    /throne pin 25\.1\.0 is not an LTS line/,
  );
});

test("a declaration found only outside the new tree does not decide its Node", async () => {
  const declaredTrees = await divergentTrees(
    { ".nvmrc": "lts/krypton\n" },
    { ".nvmrc": "16.15.1\n" },
  );
  const undeclaredTrees = await divergentTrees();
  await writeFile(path.join(undeclaredTrees.root, ".nvmrc"), "16.15.1\n");

  const declared = await hydrateWithMachine(
    declaredTrees,
    machineFor(declaredTrees),
  );
  const undeclared = await hydrateWithMachine(
    undeclaredTrees,
    machineFor(undeclaredTrees),
  );

  assert.equal(declared.node?.version, "24.19.0");
  assert.equal(undeclared.node?.version, THRONE_LTS_PIN);
  assert.equal(undeclared.node?.decidedBy, "throne pin");
});

test("a missing declared version is installed with mise before the install runs", async () => {
  const trees = await divergentTrees({ ".node-version": "22.22.0\n" });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  const commands = machine.processes.map(
    (process) => `${process.file} ${process.args.join(" ")}`,
  );
  const miseInstall = commands.indexOf("mise install node@22.22.0");
  assert.notEqual(miseInstall, -1);
  assert.ok(miseInstall < commands.indexOf("npm install"));
  assert.equal(result.node?.version, "22.22.0");
  assert.match(result.node?.reason ?? "", /installed with mise/);
});

test("the install runs with the chosen Node's bin directory first on PATH", async () => {
  const trees = await divergentTrees({ ".node-version": "22.21.1\n" });
  const machine = machineFor(trees);

  await hydrateWithMachine(trees, machine);

  assert.deepEqual(installPathEntries(machine), [
    machineBinDirectory(machine, "22.21.1"),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ]);
  assert.equal(npmProcesses(machine)[0].options.cwd, trees.destination);
});

test("the Node on the caller's PATH is never used to choose the version", async () => {
  const trees = await divergentTrees({ ".nvmrc": "lts/krypton\n" });
  const machine = machineFor(trees);
  const callerNode = path.join(trees.root, "caller-node-20", "bin");
  const callerPath = process.env.PATH;
  process.env.PATH = [callerNode, callerPath].join(path.delimiter);
  try {
    const result = await hydrateWithMachine(trees, machine);

    assert.equal(result.node?.version, "24.19.0");
  } finally {
    process.env.PATH = callerPath;
  }

  assert.equal(
    installPathEntries(machine)[0],
    machineBinDirectory(machine, "24.19.0"),
  );
  assert.ok(machine.processes.every((process) => process.file !== "node"));
});

test("an engine refusal fails once with the declared version, the version used and npm's requirement", async () => {
  const trees = await divergentTrees({ ".nvmrc": "lts/krypton\n" });
  const machine = machineFor(trees);
  machine.npmRefusal = [
    "npm error code EBADENGINE",
    "npm error engine Unsupported engine",
    'npm error notsup Required: {"node":">=26"}',
    'npm error notsup Actual:   {"npm":"11.6.2","node":"v24.19.0"}',
  ].join("\n");

  await assert.rejects(
    () => hydrateWithMachine(trees, machine),
    (error: Error) =>
      error.message.includes("declares lts/krypton") &&
      error.message.includes("used Node 24.19.0") &&
      error.message.includes('npm requires {"node":">=26"}'),
  );
  assert.equal(npmProcesses(machine).length, 1);
  await assert.rejects(access(path.join(trees.destination, "node_modules")));
});

test("the hydration result records the chosen Node and why", async () => {
  const trees = await divergentTrees({ ".nvmrc": "lts/krypton\n" });
  const machine = machineFor(trees);

  const result = await hydrateWithMachine(trees, machine);

  assert.deepEqual(result.node, {
    version: "24.19.0",
    binDirectory: machineBinDirectory(machine, "24.19.0"),
    declared: "lts/krypton",
    decidedBy: "declared",
    reason: `mise resolves lts/krypton from ${path.join(trees.destination, ".nvmrc")} to 24.19.0`,
  });
});
