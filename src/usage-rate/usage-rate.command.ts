import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { readUsageLogRaw, parseUsageLog } from '../plan-usage-remaining/telemetry-core/log.ts';
import { UsageRateCalculationService } from '../shared-policy/usage-rate-calculation.service.ts';
import { UsageRateOutputService } from '../shared-policy/usage-rate-output.service.ts';

const NO_DATA_LINE =
  'No usage readings logged yet (data/stats/usages/usage-log.jsonl empty or absent).';

export interface UsageRateDependencies {
  readLog: () => Promise<string>;
  out: (text: string) => void;
  errOut: (text: string) => void;
}

const PRODUCTION_DEPENDENCIES: UsageRateDependencies = {
  readLog: readUsageLogRaw,
  out: (text) => process.stdout.write(text),
  errOut: (text) => process.stderr.write(text),
};

let configuredDependencies: UsageRateDependencies = PRODUCTION_DEPENDENCIES;
const DEFAULT_CALCULATION = new UsageRateCalculationService();
const DEFAULT_OUTPUT = new UsageRateOutputService();

export function configureUsageRateDependencies(
  dependencies: UsageRateDependencies,
): void {
  configuredDependencies = dependencies;
}

export async function runUsageRate(
  args: string[],
  dependencies: UsageRateDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  const jsonMode = args.includes('--json');
  let raw: string;
  try {
    raw = await dependencies.readLog();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode) {
      dependencies.out(`${JSON.stringify({ source: 'error', error: message })}\n`);
    } else {
      dependencies.errOut(`usage-rate: ${message}\n`);
    }
    return 1;
  }

  const { anchor, results } = DEFAULT_CALCULATION.calculate(parseUsageLog(raw));
  if (jsonMode) {
    dependencies.out(`${JSON.stringify({ source: 'rate', anchor, results })}\n`);
  } else if (anchor === null) {
    dependencies.out(`${NO_DATA_LINE}\n`);
  } else {
    for (const line of DEFAULT_OUTPUT.format(anchor, results)) dependencies.out(`${line}\n`);
  }
  return 0;
}

@Command({
  name: 'usage-rate',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class UsageRateCommand extends CommandRunner {
  private readonly calculation: UsageRateCalculationService;
  private readonly output: UsageRateOutputService;

  constructor(calculation = DEFAULT_CALCULATION, output = DEFAULT_OUTPUT) {
    super();
    this.calculation = calculation;
    this.output = output;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    const dependencies = configuredDependencies;
    let raw: string;
    try {
      raw = await dependencies.readLog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (passedParams.includes('--json')) dependencies.out(`${JSON.stringify({ source: 'error', error: message })}\n`);
      else dependencies.errOut(`usage-rate: ${message}\n`);
      process.exitCode = 1;
      return;
    }
    const { anchor, results } = this.calculation.calculate(parseUsageLog(raw));
    if (passedParams.includes('--json')) dependencies.out(`${JSON.stringify({ source: 'rate', anchor, results })}\n`);
    else if (anchor === null) dependencies.out(`${NO_DATA_LINE}\n`);
    else for (const line of this.output.format(anchor, results)) dependencies.out(`${line}\n`);
    process.exitCode = 0;
  }
}

