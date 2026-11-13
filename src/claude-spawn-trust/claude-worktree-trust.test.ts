import assert from "node:assert/strict";
import { rmdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import {
  REAL_CLAUDE_WORKTREE_TRUST_DEPS,
  grantThroneWorktreeTrust,
  isCourtCampaignWorktree,
  type ClaudeWorktreeTrustDeps,
} from "./claude-worktree-trust.ts";

async function scratchHome(): Promise<{ deps: ClaudeWorktreeTrustDeps; home: string; worktree: string }> {
  const home = await realpath(await makeScratchDirectory("throne-trust-home-"));
  const worktree = await mkdtemp(path.join(home, "worktree-"));
  return { deps: { ...REAL_CLAUDE_WORKTREE_TRUST_DEPS, homedir: () => home, sleepMs: () => {} }, home, worktree };
}

async function readConfig(configPath: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(configPath, "utf8"));
}

test("worktree trust for a secondary agent is written into the secondary folder's own config, keeping its other keys", async () => {
  const { deps, home, worktree } = await scratchHome();
  const primaryConfigPath = path.join(home, ".claude.json");
  const secondaryConfigPath = path.join(home, "secondary.claude.json");
  await writeFile(primaryConfigPath, JSON.stringify({ numStartups: 7 }));
  await writeFile(secondaryConfigPath, JSON.stringify({ oauthAccount: { emailAddress: "keep@me.example" }, projects: { "/other": { allowedTools: ["Bash"] } } }));

  const changed = grantThroneWorktreeTrust(worktree, deps, { configPath: secondaryConfigPath, dismissesAutoModeNudge: true });

  const secondary = await readConfig(secondaryConfigPath);
  assert.equal(changed, true);
  assert.equal(secondary.projects[worktree].hasTrustDialogAccepted, true);
  assert.equal(secondary.hasSeenAutoDefaultNudge, true);
  assert.deepEqual(secondary.oauthAccount, { emailAddress: "keep@me.example" });
  assert.deepEqual(secondary.projects["/other"], { allowedTools: ["Bash"] });
  assert.deepEqual(await readConfig(primaryConfigPath), { numStartups: 7 });
});

test("worktree trust for a primary agent lands in the primary config and leaves the auto-mode nudge alone", async () => {
  const { deps, home, worktree } = await scratchHome();
  const primaryConfigPath = path.join(home, ".claude.json");
  await writeFile(primaryConfigPath, JSON.stringify({ numStartups: 7 }));

  assert.equal(grantThroneWorktreeTrust(worktree, deps), true);
  assert.equal(grantThroneWorktreeTrust(worktree, deps), false);

  const primary = await readConfig(primaryConfigPath);
  assert.equal(primary.projects[worktree].hasTrustDialogAccepted, true);
  assert.equal(primary.hasSeenAutoDefaultNudge, undefined);
  assert.equal(primary.numStartups, 7);
});

test("a campaign worktree stays trusted when a running Claude Code saves its config from the copy it read under its own lock", async () => {
  const { deps, home, worktree } = await scratchHome();
  const configPath = path.join(home, ".claude.json");
  const claudeCodeLockPath = `${configPath}.lock`;
  await writeFile(configPath, JSON.stringify({ numStartups: 7 }));
  const copyClaudeCodeRead = await readFile(configPath, "utf8");
  await mkdir(claudeCodeLockPath);
  let claudeCodeSaved = false;
  const finishClaudeCodeSave = (): void => {
    if (claudeCodeSaved) return;
    claudeCodeSaved = true;
    const saved = { ...JSON.parse(copyClaudeCodeRead), numStartups: 8 };
    writeFileSync(configPath, JSON.stringify(saved));
    rmdirSync(claudeCodeLockPath);
  };

  grantThroneWorktreeTrust(worktree, { ...deps, sleepMs: finishClaudeCodeSave });
  finishClaudeCodeSave();

  const config = await readConfig(configPath);
  assert.equal(config.projects?.[worktree]?.hasTrustDialogAccepted, true);
  assert.equal(config.numStartups, 8);
});

test("only a folder under the throne home's worktrees folder counts as a court campaign worktree", async () => {
  const { deps, home } = await scratchHome();
  const throneHome = path.join(home, "throne-home");
  const campaignWorktree = path.join(throneHome, "worktrees", "repo", "alpha-one");
  await mkdir(campaignWorktree, { recursive: true });
  const previousThroneHome = process.env.THRONE_DATA_HOME;
  process.env.THRONE_DATA_HOME = throneHome;
  try {
    assert.equal(isCourtCampaignWorktree(campaignWorktree, deps), true);
    assert.equal(isCourtCampaignWorktree(path.join(home, "personal-project"), deps), false);
    assert.equal(isCourtCampaignWorktree(path.join(throneHome, "worktrees-elsewhere"), deps), false);
  } finally {
    if (previousThroneHome === undefined) delete process.env.THRONE_DATA_HOME;
    else process.env.THRONE_DATA_HOME = previousThroneHome;
  }
});

test("a lock left behind by a Claude Code session that was killed mid-save does not stop the trust grant", async () => {
  const { deps, home, worktree } = await scratchHome();
  const configPath = path.join(home, ".claude.json");
  const abandonedLockPath = `${configPath}.lock`;
  await writeFile(configPath, JSON.stringify({ numStartups: 7 }));
  await mkdir(abandonedLockPath);
  const aMinuteAgo = new Date(Date.now() - 60_000);
  await utimes(abandonedLockPath, aMinuteAgo, aMinuteAgo);

  grantThroneWorktreeTrust(worktree, deps);

  const config = await readConfig(configPath);
  assert.equal(config.projects?.[worktree]?.hasTrustDialogAccepted, true);
  assert.equal(config.numStartups, 7);
});
