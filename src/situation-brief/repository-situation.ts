import type { BriefCommandRunner, BriefSection } from "./brief-command-runner.ts";

const LOCAL_GIT_TIMEOUT = 10_000;
const REMOTE_GIT_TIMEOUT = 8_000;

export interface RepositoryFacts {
  readonly repository: string;
  readonly branch: string;
  readonly filedBase: string | null;
}

async function git(
  run: BriefCommandRunner,
  repository: string,
  args: readonly string[],
  timeout = LOCAL_GIT_TIMEOUT,
): Promise<string | undefined> {
  const result = await run("git", args, repository, timeout);
  return result.ok ? result.stdout : undefined;
}

async function commitsBetween(
  run: BriefCommandRunner,
  repository: string,
  from: string,
  to: string,
): Promise<string> {
  return (await git(run, repository, ["rev-list", "--count", `${from}..${to}`])) ?? "?";
}

async function describeFiledBase(
  run: BriefCommandRunner,
  facts: RepositoryFacts,
  localTip: string,
): Promise<string> {
  if (facts.filedBase === null) return "No base commit was filed for this row.";
  if (facts.filedBase === localTip) return `The filed base ${facts.filedBase} IS the local tip.`;
  const baseKind = await git(run, facts.repository, ["cat-file", "-t", facts.filedBase]);
  if (baseKind !== "commit") {
    return (
      `WARNING: the filed base ${facts.filedBase} is not a commit in this repository at all. ` +
      `The row was filed with a wrong hash; ask for it to be corrected before you build on anything.`
    );
  }
  const contained = await run(
    "git",
    ["merge-base", "--is-ancestor", facts.filedBase, localTip],
    facts.repository,
    LOCAL_GIT_TIMEOUT,
  );
  if (!contained.ok) {
    return (
      `WARNING: the local tip does NOT contain the filed base ${facts.filedBase}. ` +
      `The local branch is stale or has diverged from what was filed; do not build on it until that is resolved.`
    );
  }
  const ahead = await commitsBetween(run, facts.repository, facts.filedBase, localTip);
  return `The local tip is ${ahead} commit(s) ahead of the filed base ${facts.filedBase}.`;
}

async function describeRemote(
  run: BriefCommandRunner,
  facts: RepositoryFacts,
  localTip: string | undefined,
): Promise<string> {
  const listing = await run(
    "git",
    ["ls-remote", "origin", `refs/heads/${facts.branch}`],
    facts.repository,
    REMOTE_GIT_TIMEOUT,
  );
  if (!listing.ok) return `Remote tip: unavailable (${listing.detail}).`;
  const remoteTip = listing.stdout.split(/\s+/)[0];
  if (remoteTip === undefined || remoteTip === "") {
    return `Remote tip: origin has no branch "${facts.branch}" yet.`;
  }
  if (localTip === undefined) return `Remote tip: ${remoteTip}; there is no local branch to compare.`;
  if (remoteTip === localTip) return `Remote tip: ${remoteTip}, identical to the local tip.`;
  const known = await git(run, facts.repository, ["cat-file", "-t", remoteTip]);
  if (known !== "commit") {
    return `Remote tip: ${remoteTip}, which DIFFERS from the local tip and is not fetched locally.`;
  }
  const counts = await git(run, facts.repository, [
    "rev-list",
    "--left-right",
    "--count",
    `${localTip}...${remoteTip}`,
  ]);
  const [localOnly, remoteOnly] = (counts ?? "? ?").split(/\s+/);
  return (
    `Remote tip: ${remoteTip}, which DIFFERS from the local tip: ` +
    `${localOnly} commit(s) only local, ${remoteOnly} commit(s) only on origin.`
  );
}

async function describeWorktreesHoldingBranch(
  run: BriefCommandRunner,
  facts: RepositoryFacts,
): Promise<string | undefined> {
  const listing = await git(run, facts.repository, ["worktree", "list", "--porcelain"]);
  if (listing === undefined) return undefined;
  const holders = listing
    .split("\n\n")
    .filter((entry) => entry.split("\n").includes(`branch refs/heads/${facts.branch}`))
    .map((entry) => entry.split("\n")[0]!.replace(/^worktree /, ""));
  return holders.length === 0
    ? undefined
    : `Checked out in: ${holders.join(", ")}.`;
}

export async function readRepositorySituation(
  run: BriefCommandRunner,
  facts: RepositoryFacts,
): Promise<BriefSection> {
  const title = "Repository";
  const topLevel = await git(run, facts.repository, ["rev-parse", "--show-toplevel"]);
  if (topLevel === undefined) {
    return {
      title,
      trimmable: false,
      lines: [`No git repository at ${facts.repository}, so there are no repository facts to report.`],
    };
  }
  const localTip = await git(run, facts.repository, ["rev-parse", "--verify", `${facts.branch}^{commit}`]);
  const lines = [`Repository ${facts.repository}, branch "${facts.branch}".`];
  if (localTip === undefined) {
    lines.push(`Local tip: the branch does not exist locally yet${facts.filedBase === null ? "" : `; it will be created at the filed base ${facts.filedBase}`}.`);
  } else {
    lines.push(`Local tip: ${localTip}.`, await describeFiledBase(run, facts, localTip));
  }
  lines.push(await describeRemote(run, facts, localTip));
  const holders = await describeWorktreesHoldingBranch(run, facts);
  if (holders !== undefined) lines.push(holders);
  const changed = await git(run, facts.repository, ["status", "--porcelain"]);
  if (changed !== undefined && changed !== "") {
    lines.push(`The main checkout has ${changed.split("\n").length} uncommitted change(s); they are not part of your base.`);
  }
  return { title, trimmable: false, lines };
}
