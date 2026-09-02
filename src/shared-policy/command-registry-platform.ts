import { ThroneStartupCommand } from "../throne-startup/throne-startup.command.ts";
import { DismissRegentCommand } from "../dismiss-regent/dismiss-regent.command.ts";
import { SummonRegentCommand } from "../summon-regent/summon-regent.command.ts";
import { OpenCodeGoUsageRemainingCommand } from "../opencode-go-usage-remaining/opencode-go-usage-remaining.command.ts";
import { PlanUsageRemainingCommand } from "../plan-usage-remaining/plan-usage-remaining.command.ts";
import { CodexUsageRemainingCommand } from "../codex-usage-remaining/codex-usage-remaining.command.ts";
import { ResourcePressureCommand } from "../resource-pressure/resource-pressure.command.ts";
import { TokenBalanceCommand } from "../token-balance/token-balance.command.ts";
import { CampaignEvidenceCommand } from "../campaign-evidence/campaign-evidence.command.ts";
import { SweepTmpScratchCommand } from "../sweep-tmp-scratch/sweep-tmp-scratch.command.ts";
import { ReclaimAgentScratchpadsCommand } from "../reclaim-agent-scratchpads/reclaim-agent-scratchpads.command.ts";
import {
  DisableThroneCommand,
  EnableThroneCommand,
} from "../throne-lifecycle/throne-lifecycle.command.ts";
import { RegentQueueRenderCommand } from "../regent-queue/regent-queue-render.command.ts";
import { ConsumeFenceHandoffOnStartCommand } from "../regent-fencing/consume-fence-handoff-on-start.command.ts";
import { RecordSuiteHoldCommand } from "../regent-fencing/record-suite-hold.command.ts";
import { RecordSuiteReleaseCommand } from "../regent-fencing/record-suite-release.command.ts";
import { ReadSuiteArbitrationCommand } from "../regent-fencing/read-suite-arbitration.command.ts";
import type { CommandRegistryEntry } from "./command-registry-entry.ts";

export const PLATFORM_COMMANDS: readonly CommandRegistryEntry[] = [
  {
    name: "throne-startup",
    provider: ThroneStartupCommand,
    visibility: "public",
    migrated: true,
    description: "Initialize the throne harness and heartbeat.",
  },
  {
    name: "dismiss-regent",
    provider: DismissRegentCommand,
    visibility: "public",
    migrated: true,
    description: "Stand the Regent down.",
  },
  {
    name: "summon-regent",
    provider: SummonRegentCommand,
    visibility: "public",
    migrated: true,
    description: "Bring the Regent back.",
  },
  {
    name: "opencode-go-usage-remaining",
    provider: OpenCodeGoUsageRemainingCommand,
    visibility: "public",
    migrated: true,
    description: "Report OpenCode Go usage remaining.",
  },
  {
    name: "plan-usage-remaining",
    provider: PlanUsageRemainingCommand,
    visibility: "public",
    migrated: true,
    description: "Report Claude plan usage remaining.",
  },
  {
    name: "codex-usage-remaining",
    provider: CodexUsageRemainingCommand,
    visibility: "public",
    migrated: true,
    description: "Report Codex plan usage remaining.",
  },
  {
    name: "resource-pressure",
    provider: ResourcePressureCommand,
    visibility: "public",
    migrated: true,
    description:
      "Report host capacity pressure: the admission-gate PSI verdict plus load, IO, and memory context.",
  },
  {
    name: "token-balance",
    provider: TokenBalanceCommand,
    visibility: "public",
    migrated: true,
    description:
      "Report the token-lane load balancer's verdict: which of SonnetLow/TerraLow new balanced-role spawns should use, or why both are unusable.",
  },
  {
    name: "campaign-evidence",
    provider: CampaignEvidenceCommand,
    visibility: "public",
    migrated: true,
    description: "Generate campaign evidence.",
  },
  {
    name: "sweep-tmp-scratch",
    provider: SweepTmpScratchCommand,
    visibility: "public",
    migrated: false,
    description: "Sweep unheld, aged scratch directories (dry-run by default).",
    ownHelp: true,
  },
  {
    name: "reclaim-agent-scratchpads",
    provider: ReclaimAgentScratchpadsCommand,
    visibility: "public",
    migrated: false,
    description:
      "Positive-attribution reclaim of dead agents' /tmp session scratchpads — deny by default (dry-run by default).",
    ownHelp: true,
  },
  {
    name: "disable-throne",
    provider: DisableThroneCommand,
    visibility: "public",
    migrated: true,
    description: "Stop the throne's systemd units. Messages no agent.",
  },
  {
    name: "enable-throne",
    provider: EnableThroneCommand,
    visibility: "public",
    migrated: true,
    description: "Start the throne's systemd units. Messages no agent.",
  },
  {
    name: "render-queue",
    provider: RegentQueueRenderCommand,
    visibility: "public",
    migrated: false,
    description:
      "Render the SQLite Regent queue store's current state as readable markdown.",
  },
  {
    name: "consume-fence-handoff-on-start",
    provider: ConsumeFenceHandoffOnStartCommand,
    visibility: "public",
    migrated: false,
    description:
      "Reads and clears the current fence handoff record, so a freshly-summoned Regent learns why its predecessor was fenced before it processes any pane message.",
  },
  {
    name: "record-suite-hold",
    provider: RecordSuiteHoldCommand,
    visibility: "public",
    migrated: false,
    description:
      "Records that a campaign now holds full-suite access, so a fenced Regent's successor can learn who was mid-sequence.",
  },
  {
    name: "record-suite-release",
    provider: RecordSuiteReleaseCommand,
    visibility: "public",
    migrated: false,
    description: "Records that a campaign has released full-suite access.",
  },
  {
    name: "read-suite-arbitration",
    provider: ReadSuiteArbitrationCommand,
    visibility: "public",
    migrated: false,
    description: "Prints the campaigns currently holding full-suite access.",
  },
] as const;
