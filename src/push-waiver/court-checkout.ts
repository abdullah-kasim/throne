import path from "node:path";
import { pathExists, readGitStatus } from "../git-lifecycle/git-command.service.ts";
import { PushWaiverRefusal } from "./push-waiver-refusal.ts";

export interface CourtCheckout {
  readonly agent: string;
  readonly topLevel: string;
  readonly ledger: string;
}

async function readTopLevel(repo: string): Promise<string> {
  const status = await readGitStatus(["rev-parse", "--show-toplevel"], repo).catch(() => undefined);
  if (status === undefined || status.code !== 0) {
    throw new PushWaiverRefusal(`${repo} is not a git repository.`);
  }
  return status.stdout.trim();
}

function liesUnderCourtWorktrees(topLevel: string, dataHome: string): boolean {
  return topLevel.startsWith(path.join(dataHome, "worktrees") + path.sep);
}

export async function resolveCourtCheckout(repo: string, dataHome: string): Promise<CourtCheckout> {
  const topLevel = await readTopLevel(repo);
  const agent = path.basename(topLevel);
  const ledger = path.join(dataHome, "data", agent);
  if (!liesUnderCourtWorktrees(topLevel, dataHome) || !(await pathExists(path.join(ledger, "identity.md")))) {
    throw new PushWaiverRefusal(
      `${topLevel} is not a court checkout: a court checkout lies under ${path.join(dataHome, "worktrees")} and has a ledger identity at ${path.join(ledger, "identity.md")}.`,
    );
  }
  return { agent, topLevel, ledger };
}
