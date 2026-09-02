import { Command as CommanderCommand } from 'commander';
import { Inject } from '@nestjs/common';
import { Command, CommandRunner } from 'nest-commander';
import { HerdrSessionService } from '../herdr/herdr-session.service.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

export type HerdrSessionPresence = () => Promise<boolean>;

type HerdrPreflightOutcome = {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
  readonly status: number;
};

const HERDR_PRESENT_OUTCOME: HerdrPreflightOutcome = {
  stream: 'stdout',
  text: 'herdr session detected — preflight OK.\n',
  status: 0,
};

const HERDR_ABSENT_OUTCOME: HerdrPreflightOutcome = {
  stream: 'stderr',
  text: `Not running inside a herdr session. Relaunch this harness under herdr before continuing.\n${renderEntranceRefusal({
    reason: 'assert-herdr entrance policy requires a herdr session.',
    bypass: undefined,
    supervisorRoute: 'Ask your supervisor to relaunch this harness under herdr.',
  })}\n`,
  status: 1,
};

export function herdrPreflightOutcome(
  herdrSessionPresent: boolean,
): HerdrPreflightOutcome {
  return herdrSessionPresent ? HERDR_PRESENT_OUTCOME : HERDR_ABSENT_OUTCOME;
}

@Command({
  name: 'assert-herdr',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class AssertHerdrCommand extends CommandRunner {
  private readonly herdrSessionPresence: HerdrSessionPresence;

  constructor(
    @Inject(HerdrSessionService)
    herdrSession: HerdrSessionService | HerdrSessionPresence,
  ) {
    super();
    this.herdrSessionPresence = typeof herdrSession === 'function'
      ? herdrSession
      : () => herdrSession.isInside();
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(_passedParams: string[]): Promise<void> {
    const outcome = herdrPreflightOutcome(await this.herdrSessionPresence());
    process[outcome.stream].write(outcome.text);
    process.exitCode = outcome.status;
  }
}
