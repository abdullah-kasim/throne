import type { Type } from "@nestjs/common";
import { AddToQueueCommand } from "../add-to-queue/add-to-queue.command.ts";
import { UpdateQueueCommand } from "../update-queue/update-queue.command.ts";
import { AmendmentCommand } from "../amendment/amendment.command.ts";
import { ReleaseDeferredCommand } from "../release-deferred/release-deferred.command.ts";
import { CheckQueueAmendmentsReconciledCommand } from "../amendment/check-reconciled.command.ts";
import { SituationBriefCommand } from "../situation-brief/situation-brief.command.ts";
import { LintQueuePlanCommand } from "../lint-queue-plan/lint-queue-plan.command.ts";
import { MarkQueueLaunchEligibleCommand } from "../mark-queue-launch-eligible/mark-queue-launch-eligible.command.ts";
import { ReconcileQueueCommand } from "../reconcile-queue/reconcile-queue.command.ts";
import { CheckInFlightRowsCommand } from "../check-in-flight-rows/check-in-flight-rows.command.ts";
import { StageLaunchBriefCommand } from "../stage-launch-brief/stage-launch-brief.command.ts";
import { RegentQueueMigrateCommand } from "../regent-queue/regent-queue-migrate.command.ts";
import { InstallServicesCommand } from "../install-services/install-services.command.ts";
import { EnsureHarnessSetupCommand } from "../ensure-harness-setup/ensure-harness-setup.command.ts";
import { AttachThroneHerdrCommand } from "../attach-throne-herdr/attach-throne-herdr.command.ts";
import { WorkLogCommand } from "../work-log/work-log.command.ts";
import { WhereIStandCommand } from "../where-i-stand/where-i-stand.command.ts";
import { CheckWhereIStandCommand } from "../where-i-stand/check-where-i-stand.command.ts";
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
      "Correct mutable fields on a Regent queue item. Body edits: --prepend-body / --append-body amend, --replace-body (alias --body) discards the stored body. --status deferred requires --depends-on and --defer-reason; a deferred row is moved to open only by release-deferred.",
  },
  {
    name: "release-deferred",
    provider: ReleaseDeferredCommand,
    visibility: "public",
    migrated: true,
    description:
      "Release a deferred queue row to open, record who asked, who released it and why, and send the requester one reply. Regent, or the Stager that filed the row.",
  },
  {
    name: "amendment",
    provider: AmendmentCommand,
    visibility: "public",
    migrated: true,
    description:
      "Record the Lord's amendment on a queue row as a numbered AMENDMENT, and tell that row's in-flight Alpha and the Regent. Refuses rows that are already delivered. Stager or Regent only.",
  },
  {
    name: "check-queue-amendments-reconciled",
    provider: CheckQueueAmendmentsReconciledCommand,
    visibility: "public",
    migrated: true,
    description:
      "Exit 0 when an Alpha's plan records every amendment on its queue row as reconciled, exit 66 when one is not. Used to refuse pushing and merging past an unread amendment.",
  },
  {
    name: "situation-brief",
    provider: SituationBriefCommand,
    visibility: "public",
    migrated: true,
    description:
      "Print the launch situation for a queue row: its recorded amendments, local and remote branch state, other queue work on the same repository, open pull requests and cited commits. Appended to every new Alpha's opening prompt.",
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
    name: "check-in-flight-rows",
    provider: CheckInFlightRowsCommand,
    visibility: "public",
    migrated: true,
    description:
      "List every in-flight queue row whose recorded Alpha is not live and not still starting, with that Alpha's state. Exit 1 when any exist, 0 when none do. Changes nothing.",
  },
  {
    name: "work-log",
    provider: WorkLogCommand,
    visibility: "public",
    migrated: true,
    description:
      "List the queue rows completed or updated since a date, with each row's recorded outcome and intent, and the GitHub actions logged since that date.",
  },
  {
    name: "where-i-stand",
    provider: WhereIStandCommand,
    visibility: "public",
    migrated: true,
    description:
      "Show the Lord's where-i-stand page with its version, replace it from a file when the version still matches, or add one event to its Just happened list. Any agent may write; every write is locked and journaled.",
  },
  {
    name: "check-where-i-stand",
    provider: CheckWhereIStandCommand,
    visibility: "public",
    migrated: true,
    description:
      "Exit 0 when an Alpha's campaign recorded its outcome on the Lord's where-i-stand page after it delivered, exit 66 with one sentence saying what to write when it has not. Used to refuse completing an Alpha whose work is not on the page.",
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
    name: "ensure-harness-setup",
    provider: EnsureHarnessSetupCommand,
    visibility: "public",
    migrated: true,
    description: "Re-register the throne's Claude and Codex harness hooks for the live root.",
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

export const QUEUE_COMMAND_PROVIDERS: readonly Type<unknown>[] = QUEUE_COMMANDS.map(
  (entry) => entry.provider,
);
