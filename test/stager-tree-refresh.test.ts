import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, initRepo } from "./git-repo-test-fixture.ts";
import { writeIdentity } from "../src/agentdata/identity-data.service.ts";
import { writeSpawnSpec } from "../src/agentdata/spawn-data-contracts.ts";
import { refreshStagerTreeForPrompt } from "../src/stager-tree-refresh/stager-tree-refresh.ts";
import { runRecall } from "../src/memory-recall/recall.command.ts";
import {
  PULL_REQUEST_TASK,
  harness,
} from "../src/memory-recall/recall.command.test-support.ts";

const STAGER_NAME = "stager-scratch";

interface StagerScenario {
  readonly repo: string;
  readonly ledger: string;
  readonly scratch: string;
}

async function registerAgent(
  ledger: string,
  name: string,
  role: string,
  tree: string,
): Promise<void> {
  await writeIdentity(name, { supervisor: "Regent", escalation: "Regent", role }, ledger);
  await writeSpawnSpec(name, { harness: "claude", model: "opus", effort: 3, cwd: tree }, ledger);
}

async function addTree(scenario: StagerScenario, name: string): Promise<string> {
  const tree = path.join(scenario.scratch, name);
  await git(scenario.repo, ["worktree", "add", "-b", name, tree, "main"]);
  return tree;
}

async function commitFile(checkout: string, file: string): Promise<string> {
  await writeFile(path.join(checkout, file), `${file}\n`, "utf8");
  await git(checkout, ["add", file]);
  await git(checkout, ["commit", "--no-gpg-sign", "-m", `add ${file}`]);
  return git(checkout, ["rev-parse", "HEAD"]);
}

async function stagerScenario(prefix: string): Promise<StagerScenario & { readonly tree: string }> {
  const scenario = {
    repo: await initRepo(prefix),
    ledger: await mkdtemp(path.join(os.tmpdir(), `${prefix}ledger-`)),
    scratch: await mkdtemp(path.join(os.tmpdir(), `${prefix}trees-`)),
  };
  await git(scenario.repo, ["config", "core.hooksPath", path.join(scenario.scratch, "no-hooks")]);
  const tree = await addTree(scenario, STAGER_NAME);
  await registerAgent(scenario.ledger, STAGER_NAME, "Stager", tree);
  return { ...scenario, tree };
}

function refreshPromptIn(
  scenario: StagerScenario,
  agentName: string,
  promptDirectory: string,
): Promise<string | undefined> {
  return refreshStagerTreeForPrompt({
    agentName,
    agentLedgerDirectory: scenario.ledger,
    promptDirectory,
  });
}

test("a Stager tree that is clean and behind main is fast-forwarded to main before the prompt, with one line saying so", async () => {
  const scenario = await stagerScenario("stager-behind-");
  await commitFile(scenario.repo, "one.txt");
  const mainTip = await commitFile(scenario.repo, "two.txt");

  const line = await refreshPromptIn(scenario, STAGER_NAME, scenario.tree);

  assert.equal(await git(scenario.tree, ["rev-parse", "HEAD"]), mainTip);
  assert.equal(
    line,
    `Fast-forwarded this Stager checkout 2 commits to main (${mainTip.slice(0, 7)}), so its skills and docs are current.`,
  );
});

test("a dirty Stager tree is left unchanged with a loud line naming how far behind it is", async () => {
  const scenario = await stagerScenario("stager-dirty-");
  const treeTip = await git(scenario.tree, ["rev-parse", "HEAD"]);
  await commitFile(scenario.repo, "one.txt");
  await writeFile(path.join(scenario.tree, "draft.txt"), "unsaved\n", "utf8");

  const line = await refreshPromptIn(scenario, STAGER_NAME, scenario.tree);

  assert.equal(await git(scenario.tree, ["rev-parse", "HEAD"]), treeTip);
  assert.match(line ?? "", /^WARNING: this Stager checkout is 1 commit behind main and was NOT updated, because it has uncommitted changes\./);
});

test("a Stager tree that has diverged from main is left unchanged with a loud line naming the commit counts", async () => {
  const scenario = await stagerScenario("stager-diverged-");
  const treeTip = await commitFile(scenario.tree, "stager-note.txt");
  await commitFile(scenario.repo, "one.txt");
  await commitFile(scenario.repo, "two.txt");
  await commitFile(scenario.repo, "three.txt");

  const line = await refreshPromptIn(scenario, STAGER_NAME, scenario.tree);

  assert.equal(await git(scenario.tree, ["rev-parse", "HEAD"]), treeTip);
  assert.match(line ?? "", /^WARNING: this Stager checkout is 3 commits behind main and 1 commit ahead of it, so it was NOT fast-forwarded\./);
});

test("a Stager tree already at main prints nothing", async () => {
  const scenario = await stagerScenario("stager-current-");
  const treeTip = await git(scenario.tree, ["rev-parse", "HEAD"]);

  const line = await refreshPromptIn(scenario, STAGER_NAME, scenario.tree);

  assert.equal(line, undefined);
  assert.equal(await git(scenario.tree, ["rev-parse", "HEAD"]), treeTip);
});

test("an Alpha or a Shadow tree is never fast-forwarded", async () => {
  const scenario = await stagerScenario("stager-other-roles-");
  const alphaTree = await addTree(scenario, "alpha-scratch-01");
  const shadowTree = await addTree(scenario, "shadow-scratch-01-work");
  await registerAgent(scenario.ledger, "alpha-scratch-01", "Alpha", alphaTree);
  await registerAgent(scenario.ledger, "shadow-scratch-01-work", "Shadow", shadowTree);
  const treeTip = await git(alphaTree, ["rev-parse", "HEAD"]);
  await commitFile(scenario.repo, "one.txt");

  assert.equal(await refreshPromptIn(scenario, "alpha-scratch-01", alphaTree), undefined);
  assert.equal(await refreshPromptIn(scenario, "shadow-scratch-01-work", shadowTree), undefined);

  assert.equal(await git(alphaTree, ["rev-parse", "HEAD"]), treeTip);
  assert.equal(await git(shadowTree, ["rev-parse", "HEAD"]), treeTip);
});

test("the prompt hook still prints recalled memories after refreshing the tree", async () => {
  const scenario = await stagerScenario("stager-recall-");
  const mainTip = await commitFile(scenario.repo, "one.txt");
  const fixture = harness({ hookEnabled: true });

  const exitCode = await runRecall(["--hook"], {
    ...fixture.dependencies,
    tabAgentName: STAGER_NAME,
    agentLedgerDirectory: scenario.ledger,
    readStdin: () =>
      Promise.resolve(
        JSON.stringify({
          session_id: "stager-session",
          cwd: scenario.tree,
          hook_event_name: "UserPromptSubmit",
          prompt: PULL_REQUEST_TASK,
        }),
      ),
  });

  assert.equal(exitCode, 0);
  assert.equal(await git(scenario.tree, ["rev-parse", "HEAD"]), mainTip);
  assert.match(fixture.stdout[0] ?? "", /^Fast-forwarded this Stager checkout 1 commit to main/);
  assert.match(fixture.stdout.slice(1).join(""), /NEVER_REPUBLISH/);
});
