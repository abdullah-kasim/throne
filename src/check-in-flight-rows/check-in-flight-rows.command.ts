import { Command } from 'nest-commander';
import { OwnHelpCommandRunner } from '../shared-policy/own-help-command-runner.ts';
import {
  formatInFlightRowWithoutLiveAlpha,
  readInFlightRowsWithoutLiveAlpha,
  REAL_IN_FLIGHT_ROW_CHECK_DEPENDENCIES,
  type InFlightRowCheckDependencies,
} from './in-flight-rows-without-live-alpha.ts';

export async function runCheckInFlightRows(
  dependencies: InFlightRowCheckDependencies = REAL_IN_FLIGHT_ROW_CHECK_DEPENDENCIES,
  writeStdout: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const findings = await readInFlightRowsWithoutLiveAlpha(dependencies);
  if (findings.length === 0) {
    writeStdout('check-in-flight-rows: none found — every in-flight row has a live or starting Alpha\n');
    return 0;
  }
  writeStdout(`check-in-flight-rows: ${findings.length} in-flight row(s) with no live Alpha:\n`);
  for (const finding of findings) {
    writeStdout(`  ${formatInFlightRowWithoutLiveAlpha(finding)}\n`);
  }
  return 1;
}

@Command({
  name: 'check-in-flight-rows',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class CheckInFlightRowsCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(): Promise<number> {
    return runCheckInFlightRows();
  }
}
