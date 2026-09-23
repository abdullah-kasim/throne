import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { gatherCandidates } from './gather-candidates.ts';
import { judgeCandidates } from './judge-candidates.ts';
import {
  readJevSwitch,
  renderedJevStatus,
  type JevSwitch,
} from '../relevance-classifier/jev-switch.ts';
import {
  loadRecallConfig,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import {
  appendLinesToLedger,
  inputHash,
  productionRecallDataDirectory,
} from '../memory-recall/recall-records.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

export interface LocatedCandidate {
  readonly path: string;
  readonly reasons: readonly string[];
  readonly score: number;
}

const DEFAULT_TOP = 15;

const ORDERING_USES_STAGE_TWO_JUDGED_PROBABILITY = false;

export interface LocateDependencies {
  loadConfig(): Promise<RecallConfig>;
  readJevSwitch(config: RecallConfig): Promise<JevSwitch>;
  gatherCandidates(
    task: string,
    roots: readonly string[],
    opts: { budget?: number },
  ): Promise<LocatedCandidate[]>;
  judgeCandidates(
    candidates: readonly LocatedCandidate[],
    task: string,
    config: RecallConfig,
  ): Promise<readonly LocatedCandidate[]>;
  dataDirectory: string;
  now(): Date;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: LocateDependencies = {
  loadConfig: () => loadRecallConfig(),
  readJevSwitch: (config) => readJevSwitch(config),
  gatherCandidates: (task, roots, opts) => gatherCandidates(task, roots, opts),
  judgeCandidates: (candidates, task, config) =>
    judgeCandidates(candidates, task, config),
  dataDirectory: productionRecallDataDirectory(),
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export const USAGE =
  'Usage: ./bin/throne-cli locate "<task>" --root <repo> [--root <repo> ...] [--top N] [--min PROBABILITY] [--json] [--budget N]\n' +
  '       ./bin/throne-cli locate --status (which backend would judge candidates now, and why)\n' +
  'Prints the files most likely to matter for a task, most likely first: a probability, the\n' +
  'path, and a one-line reason. --root is repeatable and required unless --status is given alone.\n';

interface ParsedArguments {
  readonly status: boolean;
  readonly json: boolean;
  readonly roots: readonly string[];
  readonly top?: number;
  readonly minimumProbability?: number;
  readonly budget?: number;
  readonly task: string;
}

function numberFlagValue(
  flag: string,
  value: string | undefined,
  isAcceptable: (parsed: number) => boolean,
  expectation: string,
): number {
  const parsed = Number(value);
  if (value === undefined || !isAcceptable(parsed)) {
    throw new Error(`${flag} must be ${expectation} (got ${value ?? 'nothing'})`);
  }
  return parsed;
}

function parseArguments(commandArguments: readonly string[]): ParsedArguments {
  let status = false;
  let json = false;
  let top: number | undefined;
  let minimumProbability: number | undefined;
  let budget: number | undefined;
  const roots: string[] = [];
  const positionals: string[] = [];
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === '--status') status = true;
    else if (argument === '--json') json = true;
    else if (argument === '--root') {
      const value = commandArguments[(index += 1)];
      if (value === undefined) throw new Error('--root requires a repository path');
      roots.push(value);
    } else if (argument === '--top') {
      top = numberFlagValue(
        argument,
        commandArguments[(index += 1)],
        (parsed) => Number.isInteger(parsed) && parsed >= 1,
        'a whole number of at least 1',
      );
    } else if (argument === '--min') {
      minimumProbability = numberFlagValue(
        argument,
        commandArguments[(index += 1)],
        (parsed) => parsed >= 0 && parsed <= 1,
        'a probability from 0 to 1',
      );
    } else if (argument === '--budget') {
      budget = numberFlagValue(
        argument,
        commandArguments[(index += 1)],
        (parsed) => Number.isInteger(parsed) && parsed >= 1,
        'a whole number of at least 1',
      );
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown flag "${argument}"`);
    } else positionals.push(argument);
  }
  if (status && commandArguments.length > 1) {
    throw new Error('--status must be given alone, without any other flag or argument');
  }
  const [task = ''] = positionals;
  if (!status && task.trim().length === 0) {
    throw new Error('the task is required: say what you are trying to do');
  }
  if (!status && roots.length === 0) {
    throw new Error('at least one --root <repo> is required');
  }
  return {
    status,
    json,
    roots,
    ...(top === undefined ? {} : { top }),
    ...(minimumProbability === undefined ? {} : { minimumProbability }),
    ...(budget === undefined ? {} : { budget }),
    task,
  };
}

function mostRelevantFirst(left: LocatedCandidate, right: LocatedCandidate): number {
  return right.score - left.score || left.path.localeCompare(right.path);
}

function normalizedToUnitProbability(
  candidates: readonly LocatedCandidate[],
): readonly LocatedCandidate[] {
  const highestScore = candidates.reduce(
    (highest, candidate) => Math.max(highest, candidate.score),
    0,
  );
  if (highestScore <= 0) return candidates;
  return candidates.map((candidate) => ({
    ...candidate,
    score: candidate.score / highestScore,
  }));
}

function renderedCandidates(candidates: readonly LocatedCandidate[], json: boolean): string {
  if (json) {
    return `${JSON.stringify(
      candidates.map((candidate) => ({
        path: candidate.path,
        probability: candidate.score,
        reasons: candidate.reasons,
      })),
    )}\n`;
  }
  return candidates
    .map(
      (candidate) =>
        `${candidate.path}  p=${candidate.score.toFixed(2)}  ${candidate.reasons.join(' ')}\n`,
    )
    .join('');
}

async function orderedCandidates(
  task: string,
  parsed: ParsedArguments,
  config: RecallConfig,
  dependencies: LocateDependencies,
): Promise<readonly LocatedCandidate[]> {
  const staged = await dependencies.gatherCandidates(task, parsed.roots, {
    ...(parsed.budget === undefined ? {} : { budget: parsed.budget }),
  });
  const judged = await dependencies.judgeCandidates(staged, task, config);
  const ordered = ORDERING_USES_STAGE_TWO_JUDGED_PROBABILITY
    ? judged
    : normalizedToUnitProbability(staged);
  return [...ordered].sort(mostRelevantFirst);
}

async function recordLocation(
  task: string,
  candidates: readonly LocatedCandidate[],
  dependencies: LocateDependencies,
): Promise<void> {
  const at = dependencies.now().toISOString();
  try {
    await appendLinesToLedger(dependencies.dataDirectory, [
      {
        at,
        command: 'locate',
        taskHash: inputHash(task),
        candidatesReturned: candidates.length,
      },
    ]);
  } catch (error) {
    dependencies.writeStderr(
      `locate: the results were printed but the record of it could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function locateAndPrint(
  parsed: ParsedArguments,
  config: RecallConfig,
  dependencies: LocateDependencies,
): Promise<void> {
  const ranked = await orderedCandidates(parsed.task, parsed, config, dependencies);
  const trimmed = ranked
    .filter((candidate) => candidate.score >= (parsed.minimumProbability ?? config.serveThreshold))
    .slice(0, parsed.top ?? DEFAULT_TOP);
  dependencies.writeStdout(renderedCandidates(trimmed, parsed.json));
  await recordLocation(parsed.task, trimmed, dependencies);
}

export async function runLocate(
  commandArguments: readonly string[],
  dependencies: LocateDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(commandArguments);
  } catch (error) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: `locate entrance validation refused: ${error instanceof Error ? error.message : String(error)}.`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  const config = await dependencies.loadConfig();
  if (parsed.status) {
    dependencies.writeStdout(renderedJevStatus(await dependencies.readJevSwitch(config)));
    return 0;
  }
  await locateAndPrint(parsed, config, dependencies);
  return 0;
}

@Command({
  name: 'locate',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class LocateCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runLocate(passedParams);
  }
}
