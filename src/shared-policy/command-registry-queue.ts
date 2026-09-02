import { AddToQueueCommand } from "../add-to-queue/add-to-queue.command.ts";
import { UpdateQueueCommand } from "../update-queue/update-queue.command.ts";
import { LintQueuePlanCommand } from "../lint-queue-plan/lint-queue-plan.command.ts";
import { MarkQueueLaunchEligibleCommand } from "../mark-queue-launch-eligible/mark-queue-launch-eligible.command.ts";
import { ReconcileQueueCommand } from "../reconcile-queue/reconcile-queue.command.ts";
import { StageLaunchBriefCommand } from "../stage-launch-brief/stage-launch-brief.command.ts";
import { RegentQueueMigrateCommand } from "../regent-queue/regent-queue-migrate.command.ts";
import { InstallServicesCommand } from "../install-services/install-services.command.ts";
import { AttachThroneHerdrCommand } from "../attach-throne-herdr/attach-throne-herdr.command.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";

export const QUEUE_COMMANDS: readonly CommandRegistryEntry[] = [
  {
    name: "add-to-queue",
    provider: AddToQueueCommand,
    visibility: "public",
    migrated: true,
    description: "Add a new open item to the Regent queue store. Stager role only.",
  },
  {
    name: "update-queue",
    provider: UpdateQueueCommand,
    visibility: "public",
    migrated: true,
    description:
      "Correct mutable fields on a Regent queue item. Body edits: --prepend-body / --append-body amend, --replace-body (alias --body) discards the stored body.",
  },
  {
    name: "lint-queue-plan",
    provider: LintQueuePlanCommand,
    visibility: "public",
    migrated: true,
    description:
      "Check a consolidated plan body for the Stager checklist's canonical section markers before filing it launch-ready.",
  },
  {
    name: "mark-queue-launch-eligible",
    provider: MarkQueueLaunchEligibleCommand,
    visibility: "public",
    migrated: true,
    description:
      "Mark an open queue objective launch-eligible with complete launch metadata.",
  },
  {
    name: "reconcile-queue",
    provider: ReconcileQueueCommand,
    visibility: "public",
    migrated: true,
    description:
      "Refresh queue delivery evidence, or explicitly close work absorbed by another campaign.",
  },
  {
    name: "stage-launch-brief",
    provider: StageLaunchBriefCommand,
    visibility: "public",
    migrated: false,
    description:
      "Stage, correct, or expire a Regent-authorized autoscale launch brief.",
  },
  {
    name: "migrate-queue-markdown",
    provider: RegentQueueMigrateCommand,
    visibility: "public",
    migrated: false,
    description:
      "One-way migrate the Regent's QUEUE.md/QUEUE-ARCHIVE.md content into the SQLite queue store.",
  },
  {
    name: "install-services",
    provider: InstallServicesCommand,
    visibility: "public",
    migrated: true,
    description: "Install throne hooks and services.",
  },
  {
    name: "attach-throne-herdr",
    provider: AttachThroneHerdrCommand,
    visibility: "public",
    migrated: true,
    description: "Attach to the named throne Herdr session.",
    ownHelp: true,
  },
] as const;
