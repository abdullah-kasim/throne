import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { run } from './spawn-git-tree-runtime.ts';
import { GitTreeCreationService } from '../git-lifecycle/git-tree-creation.service.ts';

@Command({
  name: 'spawn-git-tree',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SpawnGitTreeCommand extends CommandRunner {
  private readonly treeCreation: GitTreeCreationService;

  constructor(treeCreation: GitTreeCreationService) {
    super();
    this.treeCreation = treeCreation;
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await run(passedParams, { treeCreation: this.treeCreation });
  }
}

