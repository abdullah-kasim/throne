import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import {
  runReadPayload,
  type ReadPayloadDeps,
} from './read-payload.ts';

@Command({
  name: 'read-payload',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class ReadPayloadCommand extends CommandRunner {
  private readonly deps: ReadPayloadDeps | undefined;

  constructor(deps?: ReadPayloadDeps) {
    super();
    this.deps = deps;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runReadPayload(passedParams, this.deps);
  }
}
