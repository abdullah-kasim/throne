import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { listAgents } from '../herdr/herdr-runtime.service.ts';
import { sameAgentName } from '../herdr/herdr-identity-contracts.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import {
  canonicalShadowNameFromAlpha,
  type StoredObjectiveEvidence,
} from '../shared-policy/objective-contract.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

export interface DeriveShadowNameDependencies {
  readAlphaEvidence(alphaName: string): Promise<StoredObjectiveEvidence | null>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const USAGE =
  'Usage: ./bin/throne-cli derive-shadow-name-from-alpha ' +
  '<supervising-alpha-name> <slice-id>\n';

class LiveLedgerResolutionError extends Error {}

async function readAuthoritativeAlphaEvidence(
  alphaName: string,
  ledgerData: LedgerDataService = new LedgerDataService(),
): Promise<StoredObjectiveEvidence | null> {
  let liveAgents;
  try {
    liveAgents = await listAgents();
  } catch (error) {
    throw new LiveLedgerResolutionError(
      `cannot resolve the authoritative live throne ledger: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ledger = await ledgerData.resolveLiveLedger({
    invocationCwd: process.cwd(),
    liveAgents,
    sameAgentName,
  });
  if (!ledger.ok) throw new LiveLedgerResolutionError(ledger.reason);
  return ledgerData.readSpawnSpec(alphaName, ledger.dataDir);
}

const PRODUCTION_DEPENDENCIES: DeriveShadowNameDependencies = {
  readAlphaEvidence: readAuthoritativeAlphaEvidence,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export async function runDeriveShadowName(
  args: string[],
  dependencies: DeriveShadowNameDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  if (args.length !== 2) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: 'derive-shadow-name-from-alpha entrance validation requires an Alpha name and slice id.',
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 1;
  }
  const [alphaName, sliceId] = args as [string, string];
  let alphaEvidence;
  try {
    alphaEvidence = await dependencies.readAlphaEvidence(alphaName);
  } catch (error) {
    if (!(error instanceof LiveLedgerResolutionError)) throw error;
    dependencies.writeStderr(
      `derive-shadow-name-from-alpha: ${error instanceof Error ? error.message : String(error)}.\n`,
    );
    return 1;
  }
  const result = canonicalShadowNameFromAlpha({ alphaName, sliceId, alphaEvidence });
  if (!result.ok) {
    dependencies.writeStderr(
      `derive-shadow-name-from-alpha: refusing to derive a Shadow handle — ${result.reason}.\n`,
    );
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: 'derive-shadow-name-from-alpha rejected the supplied objective evidence.',
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 1;
  }
  dependencies.writeStdout(`${result.name}\n`);
  return 0;
}

@Command({
  name: 'derive-shadow-name-from-alpha',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class DeriveShadowNameFromAlphaCommand extends CommandRunner {
  private readonly dependencies: DeriveShadowNameDependencies;

  constructor(ledgerData: LedgerDataService = new LedgerDataService()) {
    super();
    this.dependencies = {
      readAlphaEvidence: (alphaName) => readAuthoritativeAlphaEvidence(alphaName, ledgerData),
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
    };
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runDeriveShadowName(passedParams, this.dependencies);
  }
}
