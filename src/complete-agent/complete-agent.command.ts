import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { getAgentStatusesRoster } from "../agent-statuses/agent-statuses-roster.ts";
import { runReapAgent } from "../reap-agent/reap-agent-runtime.ts";
import {
  hasDeliveryCommit,
  resolveDeliveryRepoRoot,
} from "../git-lifecycle/delivery-commit-proof.ts";
import { checkAgentEvidenceRequirementByName } from "../slice-evidence/agent-evidence-gate.ts";
import { readAgent } from "../herdr/herdr-runtime.service.ts";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import {
  runCompleteAgent,
  type CompleteAgentDependencies,
} from "./complete-agent.ts";

let configuredDependencies: CompleteAgentDependencies | undefined;

const REAL_DEPENDENCIES: CompleteAgentDependencies = {
  getRoster: getAgentStatusesRoster,
  reap: (name, reason) => runReapAgent([name, "--reason", reason]),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
  hasDeliveryCommit: (name) =>
    resolveDeliveryRepoRoot(name).then((root) => hasDeliveryCommit(name, root)),
  readAgent,
  readSpawnSpec,
  checkEvidenceRequirement: checkAgentEvidenceRequirementByName,
};

export function configureCompleteAgentDependencies(
  dependencies: CompleteAgentDependencies,
): void {
  configuredDependencies = dependencies;
}

@Command({
  name: "complete-agent",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CompleteAgentCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runCompleteAgent(
      passedParams,
      configuredDependencies ?? REAL_DEPENDENCIES,
    );
  }
}
