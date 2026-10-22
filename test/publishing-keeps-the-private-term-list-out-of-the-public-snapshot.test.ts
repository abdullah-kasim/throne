import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

const throneCheckout = path.resolve(import.meta.dirname, "..");
const scriptsTheCheckoutNeeds = ["publish.sh", "scripts/publish-scrub-file.sh", "scripts/lint-private-refs.sh"];
const inventedScrubFile = [
  "# invented rules",
  "s/Zorblax/example-project/g",
  "# verify: Zorblax",
  "#verify: Quindle",
  "",
].join("\n");

type InventedCheckout = { root: string; checkout: string; publicTarget: string; environment: NodeJS.ProcessEnv };

type FinishedCommand = { status: number | null; stdout: string; stderr: string };

function runQuietly(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<FinishedCommand> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function gitInCheckout(checkout: InventedCheckout, args: string[]): Promise<string> {
  const result = await runQuietly("git", args, checkout.checkout, checkout.environment);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function commitEverything(checkout: InventedCheckout) {
  await gitInCheckout(checkout, ["add", "-A"]);
  await gitInCheckout(checkout, ["commit", "--quiet", "-m", "invented"]);
}

function environmentWithoutInjectedGitConfig(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_CONFIG_")));
}

async function createInventedCheckout(context: TestContext, files: Record<string, string>): Promise<InventedCheckout> {
  const root = await mkdtemp(path.join(os.tmpdir(), "publish-scrub-file-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "private");
  const publicTarget = path.join(root, "public");
  const globalConfig = path.join(root, "gitconfig");
  await writeFile(globalConfig, "[user]\n\tname = Invented\n\temail = invented@example.com\n[core]\n\thooksPath = /dev/null\n");
  const environment = { ...environmentWithoutInjectedGitConfig(), TMPDIR: root, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  delete environment.PUBLISH_SCRUB_FILE;
  delete environment.PUBLISH_TARGET;
  await mkdir(path.join(checkout, "scripts"), { recursive: true });
  await mkdir(publicTarget);
  for (const script of scriptsTheCheckoutNeeds) {
    await copyFile(path.join(throneCheckout, script), path.join(checkout, script));
  }
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(checkout, file)), { recursive: true });
    await writeFile(path.join(checkout, file), content);
  }
  await runQuietly("git", ["init", "--quiet", "--initial-branch=main"], checkout, environment);
  await runQuietly("git", ["init", "--quiet"], publicTarget, environment);
  const invented = { root, checkout, publicTarget, environment };
  await commitEverything(invented);
  return invented;
}

function publishDryRun(checkout: InventedCheckout) {
  return runQuietly("bash", ["publish.sh", "--dry-run", "--target", checkout.publicTarget], checkout.checkout, checkout.environment);
}

function publishForReal(checkout: InventedCheckout, extraArguments: string[] = []) {
  return runQuietly("bash", ["publish.sh", "--target", checkout.publicTarget, ...extraArguments], checkout.checkout, checkout.environment);
}

async function createCheckoutWithMainOneCommitAhead(context: TestContext) {
  const checkout = await createInventedCheckout(context, { "publish-scrub.sed": inventedScrubFile, "README.md": "First.\n" });
  const olderCommit = await gitInCheckout(checkout, ["rev-parse", "--short=12", "HEAD"]);
  await writeFile(path.join(checkout.checkout, "README.md"), "Second.\n");
  await commitEverything(checkout);
  const mainCommit = await gitInCheckout(checkout, ["rev-parse", "--short=12", "main"]);
  await gitInCheckout(checkout, ["checkout", "--quiet", "-b", "older", olderCommit]);
  return { checkout, olderCommit, mainCommit };
}

async function assertNothingWasStaged(checkout: InventedCheckout) {
  assert.deepEqual((await readdir(checkout.root)).filter((entry) => entry.startsWith("throne-publish.")), []);
}

async function assertPublicTargetUntouched(checkout: InventedCheckout) {
  const branches = await runQuietly("git", ["for-each-ref"], checkout.publicTarget, checkout.environment);
  assert.equal(branches.stdout, "");
  assert.deepEqual(await readdir(checkout.publicTarget), [".git"]);
}

function lintPrivateReferences(checkout: InventedCheckout) {
  return runQuietly("bash", ["scripts/lint-private-refs.sh"], checkout.checkout, checkout.environment);
}

async function lintPassesOn(context: TestContext, files: Record<string, string>): Promise<string> {
  const checkout = await createInventedCheckout(context, files);
  const lint = await lintPrivateReferences(checkout);
  assert.equal(lint.status, 0, lint.stderr);
  return lint.stdout;
}

function stagedSnapshotFolder(dryRunOutput: string): string {
  const staged = /staged at (\S+)/.exec(dryRunOutput);
  assert.ok(staged, dryRunOutput);
  return staged[1];
}

async function listSnapshotFiles(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(folder, path.join(entry.parentPath, entry.name)));
}

test("publishing never copies publish-scrub.sed into the public snapshot and leaves no verify term in it", async (context) => {
  const checkout = await createInventedCheckout(context, {
    "publish-scrub.sed": inventedScrubFile,
    "README.md": "Built for Zorblax.\n",
  });

  const dryRun = await publishDryRun(checkout);

  assert.equal(dryRun.status, 0, dryRun.stderr);
  const snapshot = stagedSnapshotFolder(dryRun.stdout);
  const snapshotFiles = await listSnapshotFiles(snapshot);
  assert.deepEqual(snapshotFiles.sort(), ["README.md", "scripts/lint-private-refs.sh", "scripts/publish-scrub-file.sh"]);
  for (const file of snapshotFiles) {
    assert.doesNotMatch(await readFile(path.join(snapshot, file), "utf8"), /Zorblax|Quindle/);
  }
});

test("a publish dry run refuses a snapshot in which a verify term survives scrubbing", async (context) => {
  const checkout = await createInventedCheckout(context, {
    "publish-scrub.sed": inventedScrubFile,
    "notes.md": "Quindle has no rewrite rule.\n",
  });

  const dryRun = await publishDryRun(checkout);

  assert.equal(dryRun.status, 1);
  assert.match(dryRun.stderr, /banned pattern 'Quindle' survived scrubbing/);
  assert.match(dryRun.stderr, /notes\.md/);
});

test("a publish dry run from a tree whose HEAD is behind main refuses, naming both commits", async (context) => {
  const { checkout, olderCommit, mainCommit } = await createCheckoutWithMainOneCommitAhead(context);

  const dryRun = await publishDryRun(checkout);

  assert.equal(dryRun.status, 1);
  assert.equal(dryRun.stderr.trim().split("\n").length, 1, dryRun.stderr);
  assert.match(dryRun.stderr, new RegExp(`this tree is at ${olderCommit}, not main's tip \\(${mainCommit}\\); bring it to main`));
  await assertNothingWasStaged(checkout);
});

test("a publish dry run at main's tip passes", async (context) => {
  const { checkout } = await createCheckoutWithMainOneCommitAhead(context);
  await gitInCheckout(checkout, ["checkout", "--quiet", "main"]);

  const dryRun = await publishDryRun(checkout);

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry run OK/);
});

test("a real publish from a tree whose HEAD is not main's tip refuses before writing to the public repository", async (context) => {
  const { checkout, olderCommit } = await createCheckoutWithMainOneCommitAhead(context);

  const publish = await publishForReal(checkout);

  assert.equal(publish.status, 1);
  assert.match(publish.stderr, new RegExp(`this tree is at ${olderCommit}, not main's tip`));
  await assertPublicTargetUntouched(checkout);
});

test("a real publish from a branch other than main refuses even at main's tip, so the published-commit record lands on main", async (context) => {
  const { checkout } = await createCheckoutWithMainOneCommitAhead(context);
  await gitInCheckout(checkout, ["checkout", "--quiet", "-B", "older", "main"]);

  const publish = await publishForReal(checkout);

  assert.equal(publish.status, 1);
  assert.match(publish.stderr, /a real publish records the published commit on the checked-out branch, which is not main/);
  await assertPublicTargetUntouched(checkout);
});

test("a dry run off main passes only with --any-commit, and a real publish refuses --any-commit", async (context) => {
  const { checkout } = await createCheckoutWithMainOneCommitAhead(context);

  const dryRun = await runQuietly(
    "bash",
    ["publish.sh", "--dry-run", "--any-commit", "--target", checkout.publicTarget],
    checkout.checkout,
    checkout.environment,
  );
  const publish = await publishForReal(checkout, ["--any-commit"]);

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /dry run OK/);
  assert.equal(publish.status, 1);
  assert.match(publish.stderr, /--any-commit only applies to --dry-run/);
  await assertPublicTargetUntouched(checkout);
});

test("the private-reference check skips a checkout with no publish-scrub.sed", async (context) => {
  const lintOutput = await lintPassesOn(context, { "README.md": "Quindle\n" });

  assert.match(lintOutput, /no private-reference list configured at .*publish-scrub\.sed; skipping/);
});

test("the private-reference check reports a tracked file carrying a verify term", async (context) => {
  const checkout = await createInventedCheckout(context, {
    "publish-scrub.sed": inventedScrubFile,
    "docs/guide.md": "Ask the Zorblax team.\n",
    "notes.md": "Quindle\n",
  });

  const lint = await lintPrivateReferences(checkout);

  assert.equal(lint.status, 1);
  assert.match(lint.stderr, /banned pattern 'Zorblax' found[\s\S]*docs\/guide\.md:1:/);
  assert.match(lint.stderr, /banned pattern 'Quindle' found[\s\S]*notes\.md:1:/);
});

test("the private-reference check reads the scrub file named by PUBLISH_SCRUB_FILE", async (context) => {
  const checkout = await createInventedCheckout(context, { "notes.md": "Frobnitz\n" });
  const elsewhere = path.join(checkout.root, "elsewhere.sed");
  await writeFile(elsewhere, "# verify: Frobnitz\n");

  const lint = await lintPrivateReferences({ ...checkout, environment: { ...checkout.environment, PUBLISH_SCRUB_FILE: elsewhere } });

  assert.equal(lint.status, 1);
  assert.match(lint.stderr, /banned pattern 'Frobnitz' found[\s\S]*notes\.md:1:/);
});

test("the private-reference check reads a relative PUBLISH_SCRUB_FILE from the folder it was run in, as publish does", async (context) => {
  const checkout = await createInventedCheckout(context, { "notes.md": "Frobnitz\n" });
  await writeFile(path.join(checkout.root, "elsewhere.sed"), "# verify: Frobnitz\n");

  const lint = await runQuietly("bash", [path.join(checkout.checkout, "scripts/lint-private-refs.sh")], checkout.root, {
    ...checkout.environment,
    PUBLISH_SCRUB_FILE: "elsewhere.sed",
  });

  assert.equal(lint.status, 1, lint.stdout);
  assert.match(lint.stderr, /banned pattern 'Frobnitz' found[\s\S]*notes\.md:1:/);
});

test("the private-reference check ignores files publish never copies", async (context) => {
  const lintOutput = await lintPassesOn(context, {
    "publish-scrub.sed": inventedScrubFile,
    "bots/helper/persona.md": "Zorblax\n",
    ".claude/skills/publish/SKILL.md": "Quindle\n",
    "current_public_commit.txt": "Zorblax\n",
    "LICENSE": "Copyright Quindle\n",
  });

  assert.match(lintOutput, /no private references found/);
});
