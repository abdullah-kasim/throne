// Derives the launch metadata `add-to-queue` needs to mint a DEFINITELY
// dispatchable queue item. An item missing any of these fields is refused by
// the autoscaler's dispatch classifier (`classifyEffectiveQueueDecision`)
// with "delivery evidence is unknown", so deriving them at insert time is what
// makes "added to the queue" and "the autoscaler can act on it" the same fact.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface LaunchDefaults {
  readonly targetRepo: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
}

export class LaunchDefaultsUnavailableError extends Error {
  readonly name = "LaunchDefaultsUnavailableError";
  constructor(detail: string) {
    super(
      `add-to-queue: cannot derive launch metadata from the current directory ` +
        `(${detail}). Pass --target-repo, --target-branch and --base-commit ` +
        `explicitly, or run from inside the target repository's checkout.`,
    );
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Reads the repository the caller is standing in. `realpathSync` matters on
 *  this host: `/home` is a symlink to `/var/home`, and a queue item recorded
 *  under the unresolved spelling does not compare equal to the resolved one
 *  every other throne surface records. */
export function resolveGitLaunchDefaults(
  cwd: string = process.cwd(),
): LaunchDefaults {
  let targetRepo: string;
  try {
    targetRepo = realpathSync(git(["rev-parse", "--show-toplevel"], cwd));
  } catch (err) {
    throw new LaunchDefaultsUnavailableError(
      err instanceof Error ? err.message.split("\n")[0]! : String(err),
    );
  }
  const targetBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (targetBranch === "HEAD") {
    throw new LaunchDefaultsUnavailableError(
      "the checkout is in detached HEAD state, so there is no target branch",
    );
  }
  const baseCommit = git(["rev-parse", "HEAD"], cwd);
  return { targetRepo, targetBranch, baseCommit };
}

/** Mints the Alpha handle a queued objective launches under. The trailing slug
 *  is not decoration: `nameCarriesObjectiveCode` requires
 *  `alpha-<code>-<something>`, and a bare `alpha-<code>` fails that contract. */
export function defaultAlphaName(objectiveCode: string, body: string): string {
  const slug = body
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((word) => word.length > 0)
    .slice(0, 3)
    .join("-");
  return `alpha-${objectiveCode}-${slug.length > 0 ? slug : "queued"}`;
}
