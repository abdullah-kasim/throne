import { Command } from 'nest-commander';
import { OwnHelpCommandRunner } from '../shared-policy/own-help-command-runner.ts';
import { runJevProbe } from './jev-probe.ts';

@Command({
  name: 'jev-probe',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class JevProbeCommand extends OwnHelpCommandRunner {
  protected exitCodeOf(commandArguments: readonly string[]): Promise<number> {
    return runJevProbe(commandArguments);
  }
}
