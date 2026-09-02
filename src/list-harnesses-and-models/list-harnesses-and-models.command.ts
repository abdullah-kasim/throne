import type { Command as CommanderCommand } from "commander";
import { Injectable } from "@nestjs/common";
import { Command, CommandRunner } from "nest-commander";
import {
  ModelPresentationService,
  type ModelPresentationDeps,
} from "../shared-policy/model-presentation.ts";
import { assertAuthoritativeRoutingQuery } from './routing-query-authority.ts';

const PRODUCTION_DEPENDENCIES: ModelPresentationDeps = {
  out: (text) => process.stdout.write(text),
};

@Command({
  name: "list-harnesses-and-models",
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
@Injectable()
export class ListHarnessesAndModelsCommand extends CommandRunner {
  private readonly presentation: ModelPresentationService;

  constructor(presentation = new ModelPresentationService()) {
    super();
    this.presentation = presentation;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    try {
      await assertAuthoritativeRoutingQuery();
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.exitCode = this.presentation.render(
      passedParams,
      PRODUCTION_DEPENDENCIES,
    );
  }
}
