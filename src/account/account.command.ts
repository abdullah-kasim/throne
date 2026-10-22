import path from "node:path";
import { Command as CommanderCommand } from "commander";
import { Command, CommandRunner } from "nest-commander";
import { recordAccountInIdentity } from "../agentdata/identity-account-line.ts";
import { readSpawnSpec, writeSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { VENDORED_HARNESS_BINARY_DIRECTORY } from "../herdr/herdr-launch-command.ts";
import { listAgents } from "../herdr/herdr-runtime.service.ts";
import { PlanUsageRemainingService } from "../plan-usage-remaining/plan-usage-remaining.service.ts";
import { REAL_DEPS, restartHarnesses } from "../restart-harnesses/restart-harnesses-runtime.ts";
import { errorText } from "../shared-policy/error-text.ts";
import { AccountAddRefusal, addAccount } from "./account-add.ts";
import { listAccounts } from "./account-list.ts";
import { realAccountPlaces } from "./account-places.ts";
import { AccountSwitchRefusal, switchLongRunningAccount } from "./account-switch-long-running.ts";
import { ACCOUNT_HARNESSES, AccountsConfigError } from "./accounts-config.ts";
import { readRecordedAgentRole } from "./agent-account.ts";

const USAGE = "usage: account list | account add <name> | account switch-long-running <name>";
const USAGE_EXIT_CODE = 2;
const FAILURE_EXIT_CODE = 1;

function restartInPlace(names: readonly string[]) {
  const silent = () => undefined;
  return restartHarnesses({ dryRun: false, force: true, only: [...names] }, { ...REAL_DEPS, log: silent, warn: silent });
}

function isRefusal(error: unknown): boolean {
  return error instanceof AccountAddRefusal || error instanceof AccountSwitchRefusal || error instanceof AccountsConfigError;
}

@Command({
  name: "account",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AccountCommand extends CommandRunner {
  private readonly usage: PlanUsageRemainingService;

  constructor(usage: PlanUsageRemainingService) {
    super();
    this.usage = usage;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    try {
      process.exitCode = await this.dispatch(passedParams);
    } catch (error) {
      process.stderr.write(`account: ${errorText(error)}\n`);
      process.exitCode = isRefusal(error) ? USAGE_EXIT_CODE : FAILURE_EXIT_CODE;
    }
  }

  private async dispatch(passedParams: string[]): Promise<number> {
    const [subcommand, name, ...extra] = passedParams;
    const places = realAccountPlaces(ACCOUNT_HARNESSES.CLAUDE);
    if (subcommand === "list" && name === undefined) {
      const lines = await listAccounts({
        places,
        readPrimaryUsage: () => this.usage.getUsagePayload(),
        listAgents: () => listAgents(),
        readSpawnSpec: (agentName) => readSpawnSpec(agentName),
      });
      return this.print(lines, 0);
    }
    if (subcommand === "add" && name !== undefined && extra.length === 0) {
      const claudeBinary = path.join(VENDORED_HARNESS_BINARY_DIRECTORY, ACCOUNT_HARNESSES.CLAUDE);
      return this.print(await addAccount(name, { places, claudeBinary }), 0);
    }
    if (subcommand === "switch-long-running" && name !== undefined && extra.length === 0) {
      const result = await switchLongRunningAccount(name, {
        places,
        listAgents: () => listAgents(),
        readRole: readRecordedAgentRole,
        readSpawnSpec: (agentName) => readSpawnSpec(agentName),
        writeSpawnSpec: (agentName, spec) => writeSpawnSpec(agentName, spec),
        recordAccountInIdentity: (agentName, account) => recordAccountInIdentity(agentName, account),
        restartInPlace,
      });
      return this.print(result.lines, result.failed ? FAILURE_EXIT_CODE : 0);
    }
    process.stderr.write(`${USAGE}\n`);
    return USAGE_EXIT_CODE;
  }

  private print(lines: readonly string[], exitCode: number): number {
    process.stdout.write(`${lines.join("\n")}\n`);
    return exitCode;
  }
}
