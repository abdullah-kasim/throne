import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { text as readStreamAsText } from 'node:stream/consumers';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import type {
  ClassifierAnswer,
  ClassifierBackend,
  ClassifierBackendName,
} from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import {
  readJevSwitch,
  renderedJevStatus,
  type JevSwitch,
} from '../relevance-classifier/jev-switch.ts';
import {
  loadRecallConfig,
  pathWithHomeExpanded,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import {
  appendLinesToLedger,
  inputHash,
  productionRecallDataDirectory,
} from '../memory-recall/recall-records.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  gatherFileItems,
  gatherStdinItems,
  type GatheredItems,
  type RankItem,
} from './rank-items.ts';
import { requestsPackedUnderTheStateLimit } from './rank-requests.ts';

const REQUESTS_ASKED_AT_ONCE = 8;

export interface RankDependencies {
  loadConfig(): Promise<RecallConfig>;
  chooseBackend(config: RecallConfig): Promise<ClassifierBackend>;
  readJevSwitch(config: RecallConfig): Promise<JevSwitch>;
  gatherFileItems(
    pathsOrGlobs: readonly string[],
    allowedRoots: readonly string[],
  ): Promise<GatheredItems>;
  readStdin(): Promise<string>;
  dataDirectory: string;
  now(): Date;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  'Usage: ./bin/throne-cli rank "<yes/no question>" [--top N] [--min PROBABILITY] [--json] <files or globs...>\n' +
  '       <items> | ./bin/throne-cli rank "<yes/no question>" [--allow-stdin-to-jev]\n' +
  '       ./bin/throne-cli rank --status (which backend would answer now, and why)\n' +
  'Ranks files, or stdin items, by how likely each is to answer yes to the question, so you open\n' +
  'the top few instead of all of them. Prints one line per item, most likely first: the\n' +
  'probability, then the path or id. Item contents are never printed. Stdin items are one per\n' +
  'line, or JSON lines of {"id": "...", "text": "..."}.\n' +
  'With Jev off the ranking is word matching, not meaning. With Jev on, FILE CONTENTS are sent to\n' +
  'TypeSafe, but only for files under recall.rankAllowedRoots, and stdin only with\n' +
  '--allow-stdin-to-jev; everything else is ranked by word matching and named on stderr.\n' +
  'If ranking fails, every item is printed unranked: a ranking is a hint, never proof of absence.\n';

const PRODUCTION_DEPENDENCIES: RankDependencies = {
  loadConfig: () => loadRecallConfig(),
  chooseBackend: (config) => chooseClassifierBackend(config),
  readJevSwitch: (config) => readJevSwitch(config),
  gatherFileItems,
  readStdin: () => readStreamAsText(process.stdin),
  dataDirectory: productionRecallDataDirectory(),
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface ParsedArguments {
  readonly status: boolean;
  readonly json: boolean;
  readonly allowStdinToJev: boolean;
  readonly top?: number;
  readonly minimumProbability?: number;
  readonly question: string;
  readonly pathsOrGlobs: readonly string[];
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
  let allowStdinToJev = false;
  let top: number | undefined;
  let minimumProbability: number | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === '--status') status = true;
    else if (argument === '--json') json = true;
    else if (argument === '--allow-stdin-to-jev') allowStdinToJev = true;
    else if (argument === '--top') {
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
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown flag "${argument}"`);
    } else positionals.push(argument);
  }
  const [question = '', ...pathsOrGlobs] = positionals;
  if (!status && question.trim().length === 0) {
    throw new Error('the yes/no question is required: say what the items are ranked against');
  }
  return {
    status,
    json,
    allowStdinToJev,
    ...(top === undefined ? {} : { top }),
    ...(minimumProbability === undefined ? {} : { minimumProbability }),
    question,
    pathsOrGlobs,
  };
}

export interface RankedItem {
  readonly id: string;
  readonly probability: number;
  readonly backend: ClassifierBackendName;
}

interface RankingOutcome {
  readonly ranked: readonly RankedItem[];
  readonly failed: boolean;
}

async function probabilitiesFrom(
  backend: ClassifierBackend,
  question: string,
  items: readonly RankItem[],
): Promise<RankingOutcome> {
  const requests = requestsPackedUnderTheStateLimit(question, items);
  const bestProbabilityById = new Map<string, number>();
  for (let start = 0; start < requests.length; start += REQUESTS_ASKED_AT_ONCE) {
    const group = requests.slice(start, start + REQUESTS_ASKED_AT_ONCE);
    const groupAnswers = await Promise.all(
      group.map((request) =>
        askFailingOpen(backend, request.state, request.questions, {
          writeStderr: () => undefined,
        }),
      ),
    );
    if (groupAnswers.flat().some((answer: ClassifierAnswer) => answer.failedOpen)) {
      return { ranked: [], failed: true };
    }
    group.forEach((request, requestIndex) => {
      for (const answer of groupAnswers[requestIndex] ?? []) {
        const piece = request.piecesByQuestionId.get(answer.questionId);
        if (piece === undefined) continue;
        bestProbabilityById.set(
          piece.item.id,
          Math.max(bestProbabilityById.get(piece.item.id) ?? 0, answer.probability),
        );
      }
    });
  }
  return {
    failed: false,
    ranked: items.map((item) => ({
      id: item.id,
      probability: bestProbabilityById.get(item.id) ?? 0,
      backend: backend.name,
    })),
  };
}

function mostLikelyFirst(left: RankedItem, right: RankedItem): number {
  return right.probability - left.probability || left.id.localeCompare(right.id);
}

function renderedRanking(
  ranked: readonly RankedItem[],
  unrankedIds: readonly string[],
  json: boolean,
): string {
  if (json) {
    return `${JSON.stringify([
      ...ranked,
      ...unrankedIds.map((id) => ({ id, probability: null, backend: null })),
    ])}\n`;
  }
  return [
    ...ranked.map((item) => `${item.probability.toFixed(2)}  ${item.id}`),
    ...unrankedIds.map((id) => `-     ${id}`),
  ]
    .map((line) => `${line}\n`)
    .join('');
}

async function recordRanking(
  question: string,
  items: readonly RankItem[],
  ranked: readonly RankedItem[],
  failed: boolean,
  dependencies: RankDependencies,
): Promise<void> {
  const textById = new Map(items.map((item) => [item.id, item.text]));
  const at = dependencies.now().toISOString();
  try {
    await appendLinesToLedger(dependencies.dataDirectory, [
      { at, command: 'rank', questionHash: inputHash(question), itemsAsked: items.length, failed },
      ...ranked.map((item) => ({
        at,
        command: 'rank',
        questionId: item.id,
        inputHash: inputHash(`${question}\n${textById.get(item.id) ?? ''}`),
        probability: item.probability,
        backend: item.backend,
      })),
    ]);
  } catch (error) {
    dependencies.writeStderr(
      `rank: the ranking was printed but the record of it could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function rankAndPrint(
  parsed: ParsedArguments,
  config: RecallConfig,
  dependencies: RankDependencies,
): Promise<void> {
  const gathered =
    parsed.pathsOrGlobs.length > 0
      ? await dependencies.gatherFileItems(
          parsed.pathsOrGlobs,
          config.rankAllowedRoots.map((root) => pathWithHomeExpanded(root)),
        )
      : gatherStdinItems(await dependencies.readStdin(), parsed.allowStdinToJev);
  const unreadableIds = gathered.unreadable.map((item) => item.id);
  const backend = await dependencies.chooseBackend(config);
  const sentItems =
    backend.name === 'jev'
      ? gathered.items.filter((item) => item.mayBeSentToJev)
      : [];
  const keptLocalItems = gathered.items.filter((item) => !sentItems.includes(item));
  if (backend.name === 'jev' && keptLocalItems.length > 0) {
    dependencies.writeStderr(
      `rank: not sent to Jev, ranked by word matching instead (outside recall.rankAllowedRoots, or stdin without --allow-stdin-to-jev): ${keptLocalItems.map((item) => item.id).join(', ')}\n`,
    );
  }
  if (backend.name === 'rules') {
    dependencies.writeStderr(
      'rank: Jev is off, so this ranking is word matching against the question, not meaning.\n',
    );
  }
  const outcomes = await Promise.all([
    probabilitiesFrom(backend, parsed.question, sentItems),
    probabilitiesFrom(RULES_BACKEND, parsed.question, keptLocalItems),
  ]);
  if (outcomes.some((outcome) => outcome.failed)) {
    dependencies.writeStderr(
      'rank: ranking failed, so every item is listed unranked; open them as you would have without a ranking.\n',
    );
    dependencies.writeStdout(
      renderedRanking([], [...gathered.items.map((item) => item.id), ...unreadableIds], parsed.json),
    );
    await recordRanking(parsed.question, gathered.items, [], true, dependencies);
    return;
  }
  const ranked = outcomes.flatMap((outcome) => outcome.ranked).sort(mostLikelyFirst);
  const trimmed = ranked
    .filter((item) => item.probability >= (parsed.minimumProbability ?? 0))
    .slice(0, parsed.top ?? ranked.length);
  dependencies.writeStdout(renderedRanking(trimmed, unreadableIds, parsed.json));
  await recordRanking(parsed.question, gathered.items, ranked, false, dependencies);
}

export async function runRank(
  commandArguments: readonly string[],
  dependencies: RankDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(commandArguments);
  } catch (error) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: `rank entrance validation refused: ${error instanceof Error ? error.message : String(error)}.`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  try {
    const config = await dependencies.loadConfig();
    if (parsed.status) {
      dependencies.writeStdout(
        renderedJevStatus(await dependencies.readJevSwitch(config)),
      );
      return 0;
    }
    await rankAndPrint(parsed, config, dependencies);
  } catch (error) {
    dependencies.writeStderr(
      `rank: ranking failed before it began (${error instanceof Error ? error.message : String(error)}), so the items are listed as given, unranked.\n`,
    );
    dependencies.writeStdout(renderedRanking([], parsed.pathsOrGlobs, parsed.json));
  }
  return 0;
}

@Command({
  name: 'rank',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class RankCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runRank(passedParams);
  }
}
