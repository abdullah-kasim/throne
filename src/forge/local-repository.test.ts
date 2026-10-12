import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { git } from "../../test/git-repo-test-fixture.ts";
import { REPOSITORY_REGISTRY_FILE_NAME } from "../memory-recall/repository-registry.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import { PRODUCTION_FORGE_DEPENDENCIES, type ForgeDependencies } from "./forge-dependencies.ts";
import { ForgeRefusal } from "./forge-refusal.ts";
import { locateLocalRepository, noLocalCloneMessage, type CourtCheckoutLocations } from "./local-repository.ts";

const PULL_REQUEST = {
  repository: "acme/widgets",
  repositoryUrls: ["https://github.com/acme/widgets", "http://forge.example:8420/acme-copy/widgets"],
};
const MATCHING_ORIGIN = "git@github.com:acme/widgets.git";
const UNRELATED_ORIGIN = "git@github.com:acme/gadgets.git";

let root: string;
let locations: CourtCheckoutLocations;
const originalStateHome = process.env.XDG_STATE_HOME;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "forge-local-repository-")));
  process.env.XDG_STATE_HOME = path.join(root, "state");
  locations = { recallDataDirectory: path.join(root, "recall"), queueDatabasePath: path.join(root, "data", "regent-queue.sqlite") };
});

afterEach(async () => {
  if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = originalStateHome;
  await rm(root, { recursive: true, force: true });
});

async function checkoutWithOrigin(origin: string): Promise<string> {
  const checkout = await mkdtemp(path.join(root, "checkout-"));
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["remote", "add", "origin", origin]);
  return checkout;
}

async function recordForgejoCheckouts(checkouts: Record<string, string>): Promise<void> {
  await mkdir(path.join(root, "state", "forgejo"), { recursive: true });
  await writeFile(path.join(root, "state", "forgejo", "checkouts.json"), JSON.stringify(checkouts));
}

async function registerRecallCheckouts(checkouts: readonly string[]): Promise<void> {
  const entries = checkouts.map((checkout) => ({ checkout, repositoryName: path.basename(checkout), memoryDirectory: checkout, lastSeenAt: null }));
  await mkdir(locations.recallDataDirectory, { recursive: true });
  await writeFile(path.join(locations.recallDataDirectory, REPOSITORY_REGISTRY_FILE_NAME), JSON.stringify(entries));
}

function fileQueueRowTargeting(targetRepo: string): void {
  const store = openRegentQueueStore(locations.queueDatabasePath);
  try {
    store.insertItem({
      objectiveCode: "widgets",
      body: "widgets row",
      launch: { alphaName: "alpha-widgets", targetRepo, targetBranch: "main", baseCommit: "0000000" },
    });
  } finally {
    store.close();
  }
}

function recordingGitCommands(): { readonly dependencies: ForgeDependencies; readonly gitCommands: string[] } {
  const gitCommands: string[] = [];
  return {
    gitCommands,
    dependencies: {
      ...PRODUCTION_FORGE_DEPENDENCIES,
      runProcess: (file, args, options) => {
        if (file === "git") gitCommands.push(args[0] ?? "");
        return PRODUCTION_FORGE_DEPENDENCIES.runProcess(file, args, options);
      },
    },
  };
}

test("an explicit --repo wins over every registry", async () => {
  const recorded = await checkoutWithOrigin(MATCHING_ORIGIN);
  const known = await checkoutWithOrigin(MATCHING_ORIGIN);
  const explicit = await checkoutWithOrigin(UNRELATED_ORIGIN);
  await recordForgejoCheckouts({ "acme-copy/widgets": recorded });
  await registerRecallCheckouts([known]);

  const found = await locateLocalRepository(PULL_REQUEST, explicit, locations, PRODUCTION_FORGE_DEPENDENCIES);

  assert.equal(found, explicit);
});

test("the forgejo checkouts registry is used before the court's known checkouts", async () => {
  const recorded = await checkoutWithOrigin(UNRELATED_ORIGIN);
  const known = await checkoutWithOrigin(MATCHING_ORIGIN);
  await recordForgejoCheckouts({ "acme-copy/widgets": recorded });
  await registerRecallCheckouts([known]);
  fileQueueRowTargeting(known);

  const found = await locateLocalRepository(PULL_REQUEST, undefined, locations, PRODUCTION_FORGE_DEPENDENCIES);

  assert.equal(found, recorded);
});

test("a known court checkout whose origin is the pull request's repository is found", async () => {
  const unrelated = await checkoutWithOrigin(UNRELATED_ORIGIN);
  const queued = await checkoutWithOrigin("https://token@GitHub.com/acme/widgets/");
  const missing = path.join(root, "removed-checkout");
  await recordForgejoCheckouts({ "acme-copy/widgets": missing });
  await registerRecallCheckouts([missing, unrelated]);
  fileQueueRowTargeting(queued);

  const found = await locateLocalRepository(PULL_REQUEST, undefined, locations, PRODUCTION_FORGE_DEPENDENCIES);

  assert.equal(found, queued);
});

test("a pull request with no local clone is refused with the clone hint and nothing is cloned", async () => {
  const unrelated = await checkoutWithOrigin(UNRELATED_ORIGIN);
  await registerRecallCheckouts([unrelated]);
  const entriesBefore = await readdir(root);
  const recording = recordingGitCommands();

  await assert.rejects(
    locateLocalRepository(PULL_REQUEST, undefined, locations, recording.dependencies),
    (error: unknown) => error instanceof ForgeRefusal && error.message === noLocalCloneMessage("acme/widgets"),
  );

  assert.equal(noLocalCloneMessage("acme/widgets"), "no local clone of acme/widgets; pass --repo or clone it");
  assert.deepEqual(await readdir(root), entriesBefore);
  assert.deepEqual(recording.gitCommands.filter((command) => command === "clone" || command === "fetch"), []);
});
