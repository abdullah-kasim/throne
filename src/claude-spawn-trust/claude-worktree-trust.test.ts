import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { makeScratchDirectory } from "../scratch-directory.test-support.ts";
import {
  REAL_CLAUDE_WORKTREE_TRUST_DEPS,
  grantThroneWorktreeTrust,
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
