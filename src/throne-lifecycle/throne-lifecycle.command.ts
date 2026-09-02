import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { disableThrone } from './throne-lifecycle.ts';
import { ThroneLifecycleService } from './throne-lifecycle.service.ts';

function writeResult(result: Awaited<ReturnType<typeof disableThrone>>): void {
  for (const entry of result.results) {
    process.stdout.write(`${entry.action} ${entry.target}: ${entry.detail}\n`);
  }
  process.exitCode = result.code;
}

abstract class ThroneLifecycleCommand extends CommandRunner {
  protected readonly lifecycle: ThroneLifecycleService;

  constructor(lifecycle: ThroneLifecycleService) {
    super();
    this.lifecycle = lifecycle;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  protected async runLifecycle(): Promise<void> {
    writeResult(await this.execute());
  }

  protected abstract execute(): ReturnType<typeof disableThrone>;
}

@Command({ name: 'disable-throne' })
export class DisableThroneCommand extends ThroneLifecycleCommand {
  constructor(lifecycle: ThroneLifecycleService) { super(lifecycle); }

  async run(): Promise<void> { await this.runLifecycle(); }
  protected execute(): ReturnType<typeof disableThrone> { return this.lifecycle.disable(); }
}

@Command({ name: 'enable-throne' })
export class EnableThroneCommand extends ThroneLifecycleCommand {
  constructor(lifecycle: ThroneLifecycleService) { super(lifecycle); }

  async run(): Promise<void> { await this.runLifecycle(); }
  protected execute(): ReturnType<typeof disableThrone> { return this.lifecycle.enable(); }
}
