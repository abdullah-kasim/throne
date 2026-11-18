import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  hydrateDependencies,
  validateHydratedDependencies,
  type DependencyInstallPlatform,
  type NodeChoice,
} from "../src/git-lifecycle/dependency-hydration.ts";
import { git } from "./git-repo-test-fixture.ts";

const scratchParent = await mkdtemp(path.join(tmpdir(), "throne-build-cache-"));

after(() => rm(scratchParent, { recursive: true, force: true }));

async function project(
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(path.join(scratchParent, `${name}-`));
  await git(directory, ["init"]);
  await Promise.all(
    Object.entries(files).map(async ([file, content]) => {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), content);
    }),
  );
  return directory;
}

async function capturingStderr<T>(
  run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await run(), lines };
  } finally {
    process.stderr.write = original;
  }
}

const cargoManifest = '[package]\nname = "cached"\nversion = "0.1.0"\n';
const buildOutput = { "target/debug/cached": "binary\n" };

function cacheNotices(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes('"target" build cache'));
}

test("a rust worktree whose Cargo.lock differs still gets the build cache copied", async () => {
  const source = await project("source", {
    "Cargo.toml": cargoManifest,
    "Cargo.lock": "version = 3\n",
    ...buildOutput,
  });
  const destination = await project("destination", {
    "Cargo.toml": cargoManifest,
    "Cargo.lock": "version = 4\n",
  });

  const { result, lines } = await capturingStderr(() =>
    hydrateDependencies(source, destination),
  );

  await access(path.join(destination, "target/debug/cached"));
  assert.equal(result.mode, "reflink");
  assert.equal(cacheNotices(lines).length, 1);
});

test("a rust worktree whose Cargo.toml differs still gets the build cache copied", async () => {
  const source = await project("source", {
    "Cargo.toml": cargoManifest,
    ...buildOutput,
  });
  const destination = await project("destination", {
    "Cargo.toml": `${cargoManifest}\n[dependencies]\nitoa = "1"\n`,
  });

  const { lines } = await capturingStderr(() =>
    hydrateDependencies(source, destination),
  );

  await access(path.join(destination, "target/debug/cached"));
  assert.equal(cacheNotices(lines).length, 1);
});

test("a python worktree whose lockfile differs is still refused", async () => {
  const source = await project("source", {
    "pyproject.toml": '[project]\nname = "kept"\n',
    "poetry.lock": "old\n",
    ".venv/marker": "installed\n",
  });
  const destination = await project("destination", {
    "pyproject.toml": '[project]\nname = "kept"\n',
    "poetry.lock": "new\n",
  });

  await assert.rejects(
    () => hydrateDependencies(source, destination),
    /dependency hydration refuses a divergent snapshot: .*no safe destination install fallback is available for this dependency plan\./,
  );
  await assert.rejects(access(path.join(destination, ".venv")));
});

test("a repository with both npm and rust dependencies copies the build cache and installs node_modules", async () => {
  const source = await project("source", {
    "package.json": '{"name":"source"}\n',
    "Cargo.toml": cargoManifest,
    "node_modules/left-pad/index.js": "old\n",
    ...buildOutput,
  });
  const destination = await project("destination", {
    "package.json": '{"name":"destination"}\n',
    "Cargo.toml": cargoManifest,
  });
  const installs: string[] = [];
  const installer: DependencyInstallPlatform = {
    chooseNode: async (): Promise<NodeChoice> => ({
      version: "24.19.0",
      binDirectory: "/node/bin",
      declared: null,
      reason: "test",
    }) as NodeChoice,
    install: async (projectDir) => {
      installs.push(projectDir);
      await mkdir(path.join(projectDir, "node_modules"));
    },
  };

  const { result } = await capturingStderr(() =>
    hydrateDependencies(source, destination, undefined, undefined, installer),
  );

  assert.deepEqual(installs, [destination]);
  await access(path.join(destination, "target/debug/cached"));
  await assert.rejects(
    access(path.join(destination, "node_modules/left-pad")),
  );
  assert.equal(result.mode, "install");
});

test("a rust source whose cache marker is stale still has its build cache copied", async () => {
  const source = await project("source", {
    "Cargo.toml": cargoManifest,
    "target/.throne-hydration-fingerprint.json":
      '{"fingerprint":"from-an-earlier-manifest"}\n',
    ...buildOutput,
  });
  const destination = await project("destination", {
    "Cargo.toml": cargoManifest,
  });

  await hydrateDependencies(source, destination);

  await access(path.join(destination, "target/debug/cached"));
});

test("a rust worktree whose Cargo.toml changes after hydration still validates its build cache", async () => {
  const source = await project("source", {
    "Cargo.toml": cargoManifest,
    ...buildOutput,
  });
  const destination = await project("destination", {
    "Cargo.toml": cargoManifest,
  });
  await hydrateDependencies(source, destination);
  await writeFile(
    path.join(destination, "Cargo.toml"),
    `${cargoManifest}\n[dependencies]\nitoa = "1"\n`,
  );

  await validateHydratedDependencies(destination);
});
