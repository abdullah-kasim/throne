import { AssertHerdrCommand } from '../../src/assert-herdr/assert-herdr.command.ts';

export const MUTATED_ASSERT_HERDR_STATUS = 73;

export class AssertHerdrStatusMutant extends AssertHerdrCommand {
  override async run(passedParams: string[]): Promise<void> {
    await super.run(passedParams);
    process.exitCode = MUTATED_ASSERT_HERDR_STATUS;
  }
}
