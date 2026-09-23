import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import path from 'node:path';
import { text as readStreamAsText } from 'node:stream/consumers';
import { resolveMemoryDir } from '../memory-dir/memory-dir-resolver.ts';
import { PRODUCTION_MEMORY_RESOLVER_DEPS } from '../memory-dir/memory-dir-runtime.ts';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import type { ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
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
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import { readMemoriesInEachDirectoryOnce } from './memory-files.ts';
import {
  appendDecisionsToLedger,
  productionRecallDataDirectory,
  readServedFilePaths,
  recordServedFilePaths,
} from './recall-records.ts';
import {
  renderedServedMemories,
  selectMemories,
  type MemoryDecision,
} from './select-memories.ts';
import { YES } from '../relevance-classifier/classifier.types.ts';

export interface ProjectMemoryDirectory {
  readonly path: string;
  readonly repositoryName: string;
  readonly repositoryScopes: readonly string[];
}

export interface RecallDependencies {
  loadConfig(): Promise<RecallConfig>;
  chooseBackend(config: RecallConfig): Promise<ClassifierBackend>;
  readJevSwitch(config: RecallConfig): Promise<JevSwitch>;
  resolveProjectMemoryDirectory(
    directory: string,
  ): Promise<ProjectMemoryDirectory | undefined>;
  readStdin(): Promise<string>;
  currentDirectory(): string;
  dataDirectory: string;
  now(): Date;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

export const USAGE =
  'Usage: ./bin/throne-cli recall [--session ID] [--directory DIR] "<task text>"\n' +
  '       ./bin/throne-cli recall --hook   (reads a prompt-submit hook JSON payload on stdin)\n' +
  '       ./bin/throne-cli recall --status (which backend would answer now, and why)\n' +
  'Prints the bodies of the recorded memories that apply to the task, most relevant first,\n' +
  'capped in total size. Memories come from the project memory directory of DIR (default: the\n' +
  'current directory) and from recall.globalMemoryDirectories in config.user.ts.\n' +
  '--session ID remembers what was printed for that session and never prints it twice.\n' +
  '--hook prints nothing unless recall.hookEnabled is true, and never exits non-zero.\n' +
  'Decisions are appended to ~/.throne/data/recall/ledger.jsonl (confident no answers are only counted).\n';

export const MILLISECONDS_ALLOWED_FOR_FINDING_THE_PROJECT_MEMORY_DIRECTORY = 1500;

function undefinedAfter(milliseconds: number): Promise<undefined> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(undefined), milliseconds).unref();
  });
}

async function productionProjectMemoryDirectory(
  directory: string,
): Promise<ProjectMemoryDirectory | undefined> {
  try {
    const resolution = await Promise.race([
      resolveMemoryDir(directory, PRODUCTION_MEMORY_RESOLVER_DEPS),
      undefinedAfter(MILLISECONDS_ALLOWED_FOR_FINDING_THE_PROJECT_MEMORY_DIRECTORY),
    ]);
    if (resolution === undefined) return undefined;
    return {
      path: resolution.path,
      repositoryName: path.basename(resolution.repoRoot),
      repositoryScopes: [
        path.basename(resolution.path),
        path.basename(resolution.repoRoot),
      ],
    };
  } catch {
    return undefined;
  }
}

const PRODUCTION_DEPENDENCIES: RecallDependencies = {
  loadConfig: () => loadRecallConfig(),
  chooseBackend: (config) => chooseClassifierBackend(config),
  readJevSwitch: (config) => readJevSwitch(config),
  resolveProjectMemoryDirectory: productionProjectMemoryDirectory,
  readStdin: () => readStreamAsText(process.stdin),
  currentDirectory: () => process.cwd(),
  dataDirectory: productionRecallDataDirectory(),
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

interface RecallRequest {
  readonly taskText: string;
  readonly sessionId?: string;
  readonly directory?: string;
}

interface ParsedArguments extends Partial<RecallRequest> {
  readonly hook: boolean;
  readonly status: boolean;
}

function parseArguments(commandArguments: readonly string[]): ParsedArguments {
  let hook = false;
  let status = false;
  let sessionId: string | undefined;
  let directory: string | undefined;
  const taskWords: string[] = [];
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === '--hook') hook = true;
    else if (argument === '--status') status = true;
    else if (argument === '--session' || argument === '--directory') {
      const value = commandArguments[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === '--session') sessionId = value;
      else directory = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown flag "${argument}"`);
    } else taskWords.push(argument);
  }
  const taskText = taskWords.join(' ').trim();
  if (status) return { hook: false, status };
  if (!hook && taskText.length === 0) {
    throw new Error('the task text is required: say what the work is about');
  }
  if (hook && taskText.length > 0) {
    throw new Error('--hook reads the task from stdin and takes no task text');
  }
  return { hook, status, taskText, sessionId, directory };
}

export function recallRequestFromHookPayload(
  payloadText: string,
): RecallRequest | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { prompt, session_id: sessionId, cwd } = payload as Record<string, unknown>;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return undefined;
  return {
    taskText: prompt,
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof cwd === 'string' ? { directory: cwd } : {}),
  };
}

async function printRecalledMemories(
  request: RecallRequest,
  config: RecallConfig,
  timeoutMilliseconds: number | undefined,
  dependencies: RecallDependencies,
): Promise<void> {
  const projectMemoryDirectory = await dependencies.resolveProjectMemoryDirectory(
    request.directory ?? dependencies.currentDirectory(),
  );
  const memoryDirectories = [
    ...(projectMemoryDirectory === undefined ? [] : [projectMemoryDirectory.path]),
    ...config.globalMemoryDirectories.map((directory) =>
      pathWithHomeExpanded(directory),
    ),
  ];
  const memories = await readMemoriesInEachDirectoryOnce(memoryDirectories);
  const alreadyServedFilePaths =
    request.sessionId === undefined
      ? new Set<string>()
      : await readServedFilePaths(dependencies.dataDirectory, request.sessionId);
  const decisions = await selectMemories(
    {
      taskText: request.taskText,
      ...(projectMemoryDirectory === undefined
        ? {}
        : { repositoryName: projectMemoryDirectory.repositoryName }),
      memories,
      repositoryScopes: projectMemoryDirectory?.repositoryScopes ?? [],
      alreadyServedFilePaths,
      backend: await dependencies.chooseBackend(config),
      config,
      timeoutMilliseconds,
    },
    { writeStderr: dependencies.writeStderr },
  );
  dependencies.writeStdout(renderedServedMemories(decisions));
  reportRelevantMemoriesLeftOutForSize(decisions, dependencies);
  await recordWhatWasDecided(
    request,
    decisions,
    alreadyServedFilePaths,
    dependencies,
  );
}

function reportRelevantMemoriesLeftOutForSize(
  decisions: readonly MemoryDecision[],
  dependencies: RecallDependencies,
): void {
  const leftOut = decisions.filter(
    (decision) => decision.answer.pick === YES && !decision.served,
  );
  if (leftOut.length === 0) return;
  dependencies.writeStderr(
    `recall: ${leftOut.length} relevant memories did not fit under recall.maximumInjectedCharacters: ${leftOut
      .map((decision) => decision.memory.fileName)
      .join(', ')}\n`,
  );
}

async function recordWhatWasDecided(
  request: RecallRequest,
  decisions: readonly MemoryDecision[],
  alreadyServedFilePaths: ReadonlySet<string>,
  dependencies: RecallDependencies,
): Promise<void> {
  const servedFilePaths = decisions
    .filter((decision) => decision.served)
    .map((decision) => decision.memory.filePath);
  try {
    if (request.sessionId !== undefined && servedFilePaths.length > 0) {
      await recordServedFilePaths(
        dependencies.dataDirectory,
        request.sessionId,
        new Set([...alreadyServedFilePaths, ...servedFilePaths]),
        dependencies.now(),
      );
    }
    await appendDecisionsToLedger(
      dependencies.dataDirectory,
      request.taskText,
      decisions,
      dependencies.now(),
    );
  } catch (error) {
    dependencies.writeStderr(
      `recall: the memories were printed but the record of it could not be written: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function runRecallForHook(
  dependencies: RecallDependencies,
): Promise<number> {
  try {
    const config = await dependencies.loadConfig();
    if (!config.hookEnabled) return 0;
    const request = recallRequestFromHookPayload(await dependencies.readStdin());
    if (request === undefined) return 0;
    await printRecalledMemories(
      request,
      config,
      config.hookTimeoutMilliseconds,
      dependencies,
    );
  } catch (error) {
    dependencies.writeStderr(
      `recall: the hook served nothing: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return 0;
}

export async function runRecall(
  commandArguments: readonly string[],
  dependencies: RecallDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(commandArguments);
  } catch (error) {
    if (commandArguments.includes('--hook')) return 0;
    dependencies.writeStderr(USAGE);
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: `recall entrance validation refused: ${error instanceof Error ? error.message : String(error)}.`,
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 2;
  }
  if (parsed.hook) return runRecallForHook(dependencies);
  const config = await dependencies.loadConfig();
  if (parsed.status) {
    dependencies.writeStdout(
      renderedJevStatus(await dependencies.readJevSwitch(config)),
    );
    return 0;
  }
  await printRecalledMemories(
    {
      taskText: parsed.taskText as string,
      ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
      ...(parsed.directory === undefined ? {} : { directory: parsed.directory }),
    },
    config,
    undefined,
    dependencies,
  );
  return 0;
}

@Command({
  name: 'recall',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class RecallCommand extends CommandRunner {
  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runRecall(passedParams);
  }
}
