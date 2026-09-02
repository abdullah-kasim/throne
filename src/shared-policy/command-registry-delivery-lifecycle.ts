import { ReapAgentCommand } from "../reap-agent/reap-agent.command.ts";
import { SpawnGitTreeCommand } from "../spawn-git-tree/spawn-git-tree.command.ts";
import { MergeGitTreeCommand } from "../merge-git-tree/merge-git-tree.command.ts";
import { MakeSquashCommitCommand } from "../make-squash-commit/make-squash-commit.command.ts";
import { LintSliceAssignmentCommand } from "../slice-assignment/lint-slice-assignment.command.ts";
import { AbsorbGitTreeCommand } from "../absorb-git-tree/absorb-git-tree.command.ts";
import { VerifyDeliveryCommand } from "../verify-delivery/verify-delivery.command.ts";
import { ValidateDeliveryCommand } from "../validate-delivery/validate-delivery.command.ts";
import { CheckMainIntegrityCommand } from "../check-main-integrity/check-main-integrity.command.ts";
import { TrimQueueCommand } from "../trim-queue/trim-queue.command.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";

export const DELIVERY_LIFECYCLE_COMMANDS: readonly CommandRegistryEntry[] = [
  {
    name: "reap-agent",
    provider: ReapAgentCommand,
    visibility: "public",
    migrated: true,
    description: "Tear an agent down with a required --reason.",
  },
  {
    name: "spawn-git-tree",
    provider: SpawnGitTreeCommand,
    visibility: "public",
    migrated: true,
    description: "Create a git worktree for a coding slice.",
  },
  {
    name: "merge-git-tree",
    provider: MergeGitTreeCommand,
    visibility: "public",
    migrated: true,
    description: "Merge a coding worktree's branch back into its target.",
  },
  {
    name: "make-squash-commit",
    provider: MakeSquashCommitCommand,
    visibility: "public",
    migrated: true,
    description:
      "Preview the one-commit squash a delivery would land, on a scratch ref. Never touches the candidate or target branch.",
  },
  {
    name: "lint-slice-assignment",
    provider: LintSliceAssignmentCommand,
    visibility: "public",
    migrated: true,
    description:
      "Exit 1 with a reason when a slice ASSIGNMENT.md is missing its mandatory completion section.",
  },
  {
    name: "absorb-git-tree",
    provider: AbsorbGitTreeCommand,
    visibility: "public",
    migrated: false,
    description:
      "Absorb a target branch into an Alpha branch and stamp the acting Shadow's own branch, atomically.",
  },
  {
    name: "verify-delivery",
    provider: VerifyDeliveryCommand,
    visibility: "public",
    migrated: false,
    description:
      "Verify a named branch's delivery from git state, independent of any report.",
  },
  {
    name: "validate-delivery",
    provider: ValidateDeliveryCommand,
    visibility: "public",
    migrated: false,
    description:
      "Check whether a commit is present on a repo's currently checked-out branch, ledger-free.",
  },
  {
    name: "check-main-integrity",
    provider: CheckMainIntegrityCommand,
    visibility: "public",
    migrated: true,
    description:
      "Detect a foreign (non-delivery) commit already landed on a protected branch, ledger-cross-checked, never trusting the author. On-demand only; performs no automatic repair.",
  },
  {
    name: "trim-queue",
    provider: TrimQueueCommand,
    visibility: "public",
    migrated: true,
    description:
      "Archive terminal (complete/abandoned) items in the Regent queue store; dry-run by default.",
  },
] as const;
