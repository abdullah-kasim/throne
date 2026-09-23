import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { text as readStreamAsText } from 'node:stream/consumers';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import {
  YES,
  yesOrNoQuestion,
  type ClassifierBackend,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import {
  readJevSwitch,
  renderedJevStatus,
  type JevSwitch,
} from '../relevance-classifier/jev-switch.ts';
import {
  loadRecallConfig,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { meaningfulWords } from '../relevance-classifier/rules-backend.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  keptLineNumbers,
  overlappingChunks,
  renderedKeptLines,
  type LineChunk,
} from './chunks.ts';

export const COMMON_FAILURE_PHRASES = [
  'error',
  'fail',
  'not ok',
  'exception',
  'panic',
  'traceback',
] as const;

const CHUNKS_ASKED_AT_ONCE = 8;

export interface SiftDependencies {
  loadConfig(): Promise<RecallConfig>;
  chooseBackend(config: RecallConfig): Promise<ClassifierBackend>;
  readJevSwitch(config: RecallConfig): Promise<JevSwitch>;
  readStdin(): Promise<string>;
  saveFullInput(text: string): Promise<string>;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  'Usage: <command> 2>&1 | ./bin/throne-cli sift "<what I am looking for>"\n' +
  '       ./bin/throne-cli sift --status (which backend would answer now, and why)\n' +
  'Reads text on stdin, saves the full input under ~/tmp, and prints only the chunks that\n' +
  'matter to what you are looking for, with their original line numbers. The last chunk is\n' +
  'always kept, an unsure answer keeps the chunk, and the final line says how many lines were\n' +
  'dropped and where the full copy is.\n';

async function saveFullInputUnderHomeTmp(text: string): Promise<string> {
  const directory = path.join(homedir(), 'tmp');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(
    directory,
    `sift-${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${process.pid}.log`,
  );
  await writeFile(filePath, text);
  return filePath;
}

const PRODUCTION_DEPENDENCIES: SiftDependencies = {
  loadConfig: () => loadRecallConfig(),
  chooseBackend: (config) => chooseClassifierBackend(config),
  readJevSwitch: (config) => readJevSwitch(config),
  readStdin: () => readStreamAsText(process.stdin),
  saveFullInput: saveFullInputUnderHomeTmp,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

function keepQuestion(
  chunk: LineChunk,
  lookingFor: string,
  keepThreshold: number,
): FailOpenQuestion {
  return {
    ...yesOrNoQuestion(
      `lines ${chunk.firstLineNumber}-${chunk.lastLineNumber}`,
      `Would someone looking for "${lookingFor}" need to read this excerpt of command output? Failures, errors and their causes always count.`,
      {
        kind: 'any-phrase',
        phrases: [...meaningfulWords(lookingFor), ...COMMON_FAILURE_PHRASES],
      },
    ),
    safePick: YES,
    minimumProbabilityOfSafePick: keepThreshold,
  };
}

async function chunksWorthKeeping(
  chunks: readonly LineChunk[],
  lookingFor: string,
  backend: ClassifierBackend,
  config: RecallConfig,
  dependencies: SiftDependencies,
): Promise<readonly LineChunk[]> {
  const lastChunk = chunks.at(-1);
  const kept: LineChunk[] = [];
  let theBackendHasStoppedAnswering = false;
  const chunksToAsk = chunks.slice(0, -1);
  for (let start = 0; start < chunksToAsk.length; start += CHUNKS_ASKED_AT_ONCE) {
    const group = chunksToAsk.slice(start, start + CHUNKS_ASKED_AT_ONCE);
    if (theBackendHasStoppedAnswering) {
      kept.push(...group);
      continue;
    }
    const groupAnswers = await Promise.all(
      group.map((chunk) =>
        askFailingOpen(
          backend,
          chunk.text,
          [keepQuestion(chunk, lookingFor, config.siftKeepThreshold)],
          { writeStderr: dependencies.writeStderr },
        ),
      ),
    );
    group.forEach((chunk, index) => {
      if (groupAnswers[index]?.[0]?.pick === YES) kept.push(chunk);
    });
    theBackendHasStoppedAnswering = groupAnswers.every(
      (answers) => answers[0]?.failedOpen === true,
    );
  }
  return lastChunk === undefined ? kept : [...kept, lastChunk];
}

function withoutTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export async function runSift(
  commandArguments: readonly string[],
  dependencies: SiftDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  if (commandArguments.length === 1 && commandArguments[0] === '--status') {
    dependencies.writeStdout(
      renderedJevStatus(
        await dependencies.readJevSwitch(await dependencies.loadConfig()),
      ),
    );
    return 0;
  }
  const unknownFlag = commandArguments.find((argument) =>
    argument.startsWith('--'),
  );
  const lookingFor = commandArguments.join(' ').trim();
  if (unknownFlag !== undefined || lookingFor.length === 0) {
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason:
          unknownFlag === undefined
            ? 'sift entrance validation refused: say what you are looking for.'
            : `sift entrance validation refused: unknown flag "${unknownFlag}".`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  const input = await dependencies.readStdin();
  let fullCopyPath: string;
  try {
    fullCopyPath = await dependencies.saveFullInput(input);
  } catch (error) {
    dependencies.writeStderr(
      `sift: kept every line because the full copy could not be saved: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    dependencies.writeStdout(input);
    return 0;
  }
  if (input.length === 0) {
    dependencies.writeStdout(`sift: the input was empty; full copy at ${fullCopyPath}\n`);
    return 0;
  }
  const lines = withoutTrailingNewline(input).split('\n');
  let config: RecallConfig;
  try {
    config = await dependencies.loadConfig();
  } catch (error) {
    dependencies.writeStderr(
      `sift: kept every line because the config could not be loaded: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    dependencies.writeStdout(input);
    return 0;
  }
  const lineNumbersToKeep = keptLineNumbers(
    await chunksWorthKeeping(
      overlappingChunks(lines),
      lookingFor,
      await dependencies.chooseBackend(config),
      config,
      dependencies,
    ),
  );
  dependencies.writeStdout(renderedKeptLines(lines, lineNumbersToKeep));
  dependencies.writeStdout(
    `sift: dropped ${lines.length - lineNumbersToKeep.size} of ${lines.length} lines; full copy at ${fullCopyPath}\n`,
  );
  return 0;
}

@Command({
  name: 'sift',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class SiftCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runSift(passedParams);
  }
}
