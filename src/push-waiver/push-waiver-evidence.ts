import { readGitStatus } from "../git-lifecycle/git-command.service.ts";
import { formatFileLine, type FileLine } from "./file-line.ts";
import { PushWaiverReason, type WaiverEntry } from "./push-waiver-entries.ts";
import { PushWaiverRefusal } from "./push-waiver-refusal.ts";

export async function resolveCommit(repo: string, commit: string): Promise<string | undefined> {
  const status = await readGitStatus(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], repo);
  return status.code === 0 ? status.stdout.trim() : undefined;
}

function countLines(text: string): number {
  const newlines = text.split("\n").length - 1;
  return text === "" || text.endsWith("\n") ? newlines : newlines + 1;
}

async function fileLineExistsAt(repo: string, commit: string, location: FileLine): Promise<boolean> {
  const blob = await readGitStatus(["cat-file", "blob", `${commit}:${location.path}`], repo);
  return blob.code === 0 && countLines(blob.stdout) >= location.line;
}

async function requireResolvedCommit(repo: string, commit: string, label: string): Promise<string> {
  const resolved = await resolveCommit(repo, commit);
  if (resolved === undefined) {
    throw new PushWaiverRefusal(`${label} cites commit ${commit}, which does not resolve in ${repo}; fetch it first.`);
  }
  return resolved;
}

async function requireFileLineAt(repo: string, commit: string, location: FileLine, label: string): Promise<void> {
  if (!(await fileLineExistsAt(repo, commit, location))) {
    throw new PushWaiverRefusal(`${label} cites ${formatFileLine(location)}, which does not exist at commit ${commit}.`);
  }
}

export async function checkEntryEvidence(entry: WaiverEntry, repo: string, pushedCommit: string): Promise<void> {
  const label = `the entry for finding ${entry.finding} (${entry.reason})`;
  if ("test" in entry) {
    return;
  }
  const commit = entry.reason === PushWaiverReason.FindingWrong
    ? pushedCommit
    : await requireResolvedCommit(repo, entry.commit, label);
  await requireFileLineAt(repo, commit, entry.location, label);
}
