import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { mkdir } from 'node:fs/promises';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  resolveMemoryDir,
  type MemoryResolution,
  type MemoryResolverDeps,
} from './memory-dir-resolver.ts';
import { PRODUCTION_MEMORY_RESOLVER_DEPS } from './memory-dir-runtime.ts';

export interface MemoryDirDependencies {
  resolve(dir: string, deps: MemoryResolverDeps): Promise<MemoryResolution>;
  resolverDeps: MemoryResolverDeps;
  createDirectory(dir: string): Promise<void>;
  cwd(): string;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  'Usage: ./bin/throne-cli memory-dir [--json] [--create] [DIR]\n' +
  'Prints the durable cross-session memory directory for the project containing DIR (default: cwd).\n' +
  'Precedence: an in-tree agent_docs/MEMORY, then a memory directive in the project AGENTS.md/CLAUDE.md,\n' +
  'then a `memory-dir` executable on PATH, then the throne-native ~/.throne/memories/<slug>.\n' +
  '--json prints {mode, path, repoRoot, evidence, warning?}; --create also mkdir -p\'s the directory.\n';

const PRODUCTION_DEPENDENCIES: MemoryDirDependencies = {
  resolve: resolveMemoryDir,
  resolverDeps: PRODUCTION_MEMORY_RESOLVER_DEPS,
  createDirectory: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  cwd: () => process.cwd(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface ParsedArgs {
  json: boolean;
  create: boolean;
  dir?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { json: false, create: false };
  for (const arg of args) {
    if (arg === '--json') parsed.json = true;
    else if (arg === '--create') parsed.create = true;
    else if (arg.startsWith('-')) throw new Error(`unknown flag "${arg}"`);
    else if (parsed.dir === undefined) parsed.dir = arg;
    else throw new Error(`unexpected argument "${arg}"`);
  }
  return parsed;
}

export async function runMemoryDir(
  args: string[],
  dependencies: MemoryDirDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: `memory-dir entrance validation refused: ${error instanceof Error ? error.message : String(error)}.`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  const dir = parsed.dir ?? dependencies.cwd();
  let resolution: MemoryResolution;
  try {
    resolution = await dependencies.resolve(dir, dependencies.resolverDeps);
  } catch (error) {
    dependencies.writeStderr(
      `memory-dir: cannot resolve a memory directory for "${dir}": ` +
        `${error instanceof Error ? error.message : String(error)}.\n`,
    );
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: 'memory-dir refused because DIR is not a readable directory or the operator memory tool misbehaved.',
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor which directory your memory should resolve from.',
      })}\n`,
    );
    return 2;
  }
  if (parsed.create) {
    await dependencies.createDirectory(resolution.path);
  }
  if (resolution.warning !== undefined) {
    dependencies.writeStderr(`memory-dir: WARNING: ${resolution.warning}\n`);
  }
  dependencies.writeStdout(
    parsed.json ? `${JSON.stringify(resolution)}\n` : `${resolution.path}\n`,
  );
  return 0;
}

@Command({
  name: 'memory-dir',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class MemoryDirCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runMemoryDir(passedParams);
  }
}
