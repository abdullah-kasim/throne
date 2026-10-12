import { GitLifecycleService } from "./git-command.service.ts";

export const CHECKOUT_STANDING = {
  UP_TO_DATE: "up-to-date",
  BEHIND: "behind",
  DIRTY: "dirty",
  DIVERGED: "diverged",
} as const;

export type CheckoutStandingKind =
  (typeof CHECKOUT_STANDING)[keyof typeof CHECKOUT_STANDING];

export interface CheckoutStanding {
  readonly kind: CheckoutStandingKind;
  readonly commitsBehind: number;
  readonly commitsAhead: number;
}

async function commitsAheadAndBehind(
  checkoutDir: string,
  ref: string,
  git: GitLifecycleService,
): Promise<{ commitsAhead: number; commitsBehind: number }> {
  const counts = await git.run(
    ["rev-list", "--left-right", "--count", `HEAD...${ref}`],
    checkoutDir,
  );
  const [commitsAhead, commitsBehind] = counts.stdout.trim().split(/\s+/).map(Number);
  return { commitsAhead: commitsAhead ?? 0, commitsBehind: commitsBehind ?? 0 };
}

export async function hasUncommittedChanges(
  checkoutDir: string,
  git: GitLifecycleService = new GitLifecycleService(),
): Promise<boolean> {
  const changes = await git.run(["status", "--porcelain"], checkoutDir);
  return changes.stdout.trim() !== "";
}

async function standingKindOf(
  checkoutDir: string,
  commitsAhead: number,
  commitsBehind: number,
  git: GitLifecycleService,
): Promise<CheckoutStandingKind> {
  if (commitsBehind === 0) return CHECKOUT_STANDING.UP_TO_DATE;
  if (await hasUncommittedChanges(checkoutDir, git)) return CHECKOUT_STANDING.DIRTY;
  return commitsAhead > 0 ? CHECKOUT_STANDING.DIVERGED : CHECKOUT_STANDING.BEHIND;
}

export async function checkoutStandingAgainst(
  checkoutDir: string,
  ref: string,
  git: GitLifecycleService = new GitLifecycleService(),
): Promise<CheckoutStanding> {
  const { commitsAhead, commitsBehind } = await commitsAheadAndBehind(checkoutDir, ref, git);
  const kind = await standingKindOf(checkoutDir, commitsAhead, commitsBehind, git);
  return { kind, commitsBehind, commitsAhead };
}

export async function fastForwardCheckoutOnto(
  checkoutDir: string,
  ref: string,
  git: GitLifecycleService = new GitLifecycleService(),
): Promise<void> {
  await git.run(["merge", "--ff-only", ref], checkoutDir);
}
