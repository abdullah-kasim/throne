import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  hydrateDependencies,
  validateHydratedDependencies,
} from "../src/git-lifecycle/dependency-hydration.ts";
import { GitTreeCreationService } from "../src/git-lifecycle/git-tree-creation.service.ts";
import { git, initRepo } from "./git-repo-test-fixture.ts";

const scratchRoots: string[] = [];

after(async () => {
  await Promise.all(
    scratchRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function newProject(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  scratchRoots.push(root);
  await git(root, ["init"]);
  return root;
}

test("empty hydration plan skips a Cargo-only destination without a package manifest", async () => {
  const source = await newProject("throne-empty-hydration-source-");
  const destination = await newProject("throne-empty-hydration-destination-");
  await writeFile(
    path.join(destination, "Cargo.toml"),
    '[package]\nname = "target"\n',
  );

  const result = await hydrateDependencies(source, destination);

  assert.deepEqual(result, {
    projectDir: destination,
    paths: [],
    mode: "skipped",
  });
});

test("an unhydrated dependency path may be absent", async () => {
  const destination = await newProject("throne-cargo-validation-");
  await writeFile(
    path.join(destination, "Cargo.toml"),
    '[package]\nname = "target"\n',
  );

  await validateHydratedDependencies(destination);
});

test("a hydrated dependency path deleted afterwards still throws", async () => {
  const source = await newProject("throne-hydrated-cargo-source-");
  const destination = await newProject("throne-hydrated-cargo-destination-");
  const cargoManifest = '[package]\nname = "hydrated"\n';
  await Promise.all([
    writeFile(path.join(source, "Cargo.toml"), cargoManifest),
    writeFile(path.join(destination, "Cargo.toml"), cargoManifest),
    mkdir(path.join(source, "target")),
  ]);

  await hydrateDependencies(source, destination);
  await rm(path.join(destination, "target"), { recursive: true, force: true });

  await assert.rejects(
    () => validateHydratedDependencies(destination),
    /declared dependency path is missing: target/,
  );
});

test("hydration provenance does not litter a target worktree", async () => {
  const source = await newProject("throne-hydrated-npm-source-");
  const destination = await newProject("throne-hydrated-npm-destination-");
  const packageManifest = '{"name":"hydrated"}\n';
  await Promise.all([
    writeFile(path.join(source, "package.json"), packageManifest),
    writeFile(path.join(destination, "package.json"), packageManifest),
    mkdir(path.join(source, "node_modules")),
  ]);

  await hydrateDependencies(source, destination);
  await assert.rejects(
    access(path.join(destination, ".throne-hydration-provenance.json")),
  );
  const gitDir = await git(destination, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  await access(path.join(gitDir, ".throne-hydration-provenance.json"));
});

test("a hydrated npm dependency path deleted afterwards still throws", async () => {
  const source = await newProject("throne-hydrated-npm-source-");
  const destination = await newProject("throne-hydrated-npm-destination-");
  const packageManifest = '{"name":"hydrated"}\n';
  await Promise.all([
    writeFile(path.join(source, "package.json"), packageManifest),
    writeFile(path.join(destination, "package.json"), packageManifest),
    mkdir(path.join(source, "node_modules")),
  ]);

  await hydrateDependencies(source, destination);
  await rm(path.join(destination, "node_modules"), {
    recursive: true,
    force: true,
  });

  await assert.rejects(
    () => validateHydratedDependencies(destination),
    /declared dependency path is missing: node_modules/,
  );
});

test("legacy root provenance is relocated without deleting user files", async () => {
  const destination = await newProject("throne-legacy-provenance-");
  const legacyPath = path.join(
    destination,
    ".throne-hydration-provenance.json",
  );
  const userFile = path.join(destination, "user-file.txt");
  await Promise.all([
    writeFile(legacyPath, '{"paths":["node_modules"]}\n'),
    writeFile(userFile, "preserve me\n"),
  ]);

  await assert.rejects(
    () =>
      validateHydratedDependencies(destination, { paths: ["node_modules"] }),
    /declared dependency path is missing: node_modules/,
  );

  await assert.rejects(access(legacyPath));
  await access(userFile);
});

test("an untrustworthy npm source hydrates a destination dependency by installing in the destination", async () => {
  const source = await newProject("throne-divergent-npm-source-");
  const destination = await newProject("throne-divergent-npm-destination-");
  await writeFile(path.join(source, "package.json"), '{"name":"source"}\n');
  await writeFile(
    path.join(destination, "package.json"),
    '{"name":"destination","dependencies":{"destination-only":"1.0.0"}}\n',
  );

  let installs = 0;
  const installer = {
    async install(projectDir: string): Promise<void> {
      installs += 1;
      await mkdir(path.join(projectDir, "node_modules"));
    },
  };

  const result = await hydrateDependencies(
    source,
    destination,
    undefined,
    undefined,
    installer,
  );

  assert.deepEqual(result, {
    projectDir: destination,
    paths: ["node_modules"],
    mode: "install",
  });
  assert.equal(installs, 1);
  await access(path.join(destination, "node_modules"));
});

test("an untrustworthy snapshot without a destination npm manifest still refuses", async () => {
  const source = await newProject("throne-unrecoverable-npm-source-");
  const destination = await newProject("throne-unrecoverable-destination-");
  await Promise.all([
    writeFile(path.join(source, "package.json"), '{"name":"source"}\n'),
    writeFile(
      path.join(destination, "Cargo.toml"),
      '[package]\nname = "destination"\n',
    ),
  ]);

  await assert.rejects(
    () => hydrateDependencies(source, destination),
    /dependency hydration refuses a divergent snapshot/,
  );
  await assert.rejects(access(path.join(destination, "node_modules")));
});

test("hydration failure removes the newly created worktree and branch", async () => {
  const root = await initRepo("throne-hydration-rollback-");
  scratchRoots.push(root);
  const worktreesHome = await mkdtemp(path.join(tmpdir(), "throne-worktrees-"));
  scratchRoots.push(worktreesHome);
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "source"\n',
  );
  await git(root, ["add", "Cargo.toml"]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "add Cargo manifest"]);
  await git(root, ["checkout", "-b", "divergent"]);
  await writeFile(
    path.join(root, "Cargo.toml"),
    '[package]\nname = "destination"\n',
  );
  await git(root, ["commit", "--no-gpg-sign", "-am", "diverge Cargo manifest"]);
  await git(root, ["checkout", "main"]);

  const previousWorktreesHome = process.env.THRONE_WORKTREES_HOME;
  process.env.THRONE_WORKTREES_HOME = worktreesHome;
  try {
    await assert.rejects(
      () =>
        new GitTreeCreationService().create(
          "hydration-failure",
          "divergent",
          root,
        ),
      /dependency hydration refuses a divergent snapshot/,
    );
  } finally {
    if (previousWorktreesHome === undefined) {
      delete process.env.THRONE_WORKTREES_HOME;
    } else {
      process.env.THRONE_WORKTREES_HOME = previousWorktreesHome;
    }
  }

  await assert.rejects(
    access(path.join(worktreesHome, path.basename(root), "hydration-failure")),
  );
  await assert.rejects(
    git(root, ["rev-parse", "--verify", "hydration-failure"]),
  );
});
