import type { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import { homedir } from 'node:os';
import path from 'node:path';
import { text as readStreamAsText } from 'node:stream/consumers';
import { resolveMemoryDir } from '../memory-dir/memory-dir-resolver.ts';
import { PRODUCTION_MEMORY_RESOLVER_DEPS } from '../memory-dir/memory-dir-runtime.ts';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import { jevDataHomeOfThisMachine } from '../relevance-classifier/jev-data-home.ts';
import {
  readJevSwitch,
  renderedJevStatus,
  type JevSwitch,
} from '../relevance-classifier/jev-switch.ts';
import {
  readJevSpendingOnThisMachine,
  type JevSpending,
} from '../relevance-classifier/jev-spending.ts';
import {
  SERVE_ARM,
  loadRecallConfig,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';
import {
  parseRecallArguments,
  type AskLintRequest,
  type ParsedRecallArguments,
} from './recall-arguments.ts';
import {
  lintAsks,
  projectMemoryDirectoriesToLint,
  renderedAskLintSummary,
  renderedAskViolation,
  type LintedMemoryDirectory,
} from './ask-lint.ts';
import {
  recallScopeOf,
  resolvedMemoryDirectoriesOf,
  searchedMemoryDirectoriesOf,
  unresolvedRepositoriesOf,
  type ProjectMemoryDirectory,
  type RecallScope,
  type RecallScopeDependencies,
} from './recall-scope.ts';
import { productionMemoryDirectoriesForRepeats } from './repeat-mistakes.ts';
import { repositoriesOfProjectMemoryDirectories } from './repository-registry.ts';
import { printRecallReport, type RecallReportDependencies } from './recall-report.ts';
import { armForPrompt } from './recall-arm.ts';
import {
  HOOK_DISABLED,
  HOOK_FAILED,
  recordSkippedHookRun,
} from './hook-outcome.ts';
import {
  isSkippedHookPayload,
  recallRequestFromHookPayload,
  type RecallRequest,
} from './hook-payload.ts';
import { promptKindOf, type PromptKind } from './prompt-kind.ts';
import {
  COMMAND_SOURCE,
  HOOK_SOURCE,
  appendPromptToPromptLog,
  inputHash,
  productionRecallDataDirectory,
} from './recall-records.ts';
import type { CorrectionVerdict } from './correction-question.ts';
import { recallForPrompt, type RecallForPromptDependencies } from './recall-for-prompt.ts';
import { percentOf } from './other-repositories-output.ts';
import { JSON_OUTPUT, TEXT_OUTPUT } from './recall-output.ts';
import { LOWEST_PROBABILITY_WORTH_SERVING } from './select-memories.ts';
import { gradedPromptsIn, printSpotCheck } from './spot-check.ts';
import { appendSpotCheckVerdict, type SpotCheckVerdict } from './spot-check-verdicts.ts';

export interface RecallDependencies
  extends RecallReportDependencies,
    RecallScopeDependencies,
    RecallForPromptDependencies {
  readJevSwitch(config: RecallConfig): Promise<JevSwitch>;
  readJevSpending(config: RecallConfig): Promise<JevSpending>;
  readStdin(): Promise<string>;
  projectMemoryDirectoriesToLint(): Promise<readonly LintedMemoryDirectory[]>;
}

export const USAGE =
  'Usage: ./bin/throne-cli recall [--session ID] (--directory DIR | --memory-dir MEMORY_DIR)... [--no-global] [--json] "<task text>"\n' +
  '       ./bin/throne-cli recall --hook   (reads a prompt-submit hook JSON payload on stdin)\n' +
  '       ./bin/throne-cli recall --status (which backend would answer now, and why, and the Jev tokens spent against both limits)\n' +
  '       ./bin/throne-cli recall --report [--since DATE] (grade every memory dig and print how well Jev did)\n' +
  '       ./bin/throne-cli recall --spot-check [--count N] (print N random graded prompts, 10 by default, with every grade)\n' +
  '       ./bin/throne-cli recall --agree ID | --disagree ID "<reason>" (record your verdict on the judge for a spot-checked prompt)\n' +
  '       ./bin/throne-cli recall --lint-asks [--directory DIR]... [--global] (print every memory ask that breaks an ask rule; never edits)\n' +
  'Prints the bodies of the recorded memories that apply to the task, most relevant first,\n' +
  'capped in total size. A hand recall must name what to search: each --directory DIR (a repository or\n' +
  'any path inside it) adds that repository\'s memory directory, each --memory-dir MEMORY_DIR adds that\n' +
  'directory as given; both repeat. recall.globalMemoryDirectories in config.user.ts is searched too unless\n' +
  '--no-global is passed. The output names every directory it searched.\n' +
  '--session ID remembers what was printed for that session and never prints it twice.\n' +
  `After the verdict line, each other repository Jev rates at least ${percentOf(LOWEST_PROBABILITY_WORTH_SERVING)} likely to hold a relevant memory\n` +
  '(the serving floor; at most three, most likely first) is named with its probability and a recall command\n' +
  'carrying the task, to run before looking it up yourself; it is never searched here. Less likely\n' +
  'repositories are not printed. Every repository recall searches is remembered in\n' +
  '~/.throne/data/recall/repositories.json for this question.\n' +
  '--json prints { scope, verdict, memories, withheldMemories, otherRepositories } instead of the text.\n' +
  '--hook prints nothing unless recall.hookEnabled is true, and never exits non-zero. It searches only the\n' +
  'repository the session sits in plus the global memories, and says so whenever it prints. Each hook prompt is\n' +
  'appended to ~/.throne/data/recall/prompts.jsonl; recall.hookMode picks serve, shadow (judge and record,\n' +
  'print nothing) or split (a coin per prompt). A verdict line naming who answered (Jev with its confidence, or the rules) follows the memories.\n' +
  'Decisions are appended to ~/.throne/data/recall/ledger.jsonl (confident no answers are only counted).\n' +
  '--agree and --disagree append to ~/.throne/data/recall/spot-checks.jsonl; --report shows how often the judge\n' +
  'agrees with you once there are 10 verdicts.\n';

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
      checkout: resolution.repoRoot,
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
  chooseBackend: (config, caller) => chooseClassifierBackend(config, caller),
  readJevSwitch: (config) => readJevSwitch(config),
  readJevSpending: (config) => readJevSpendingOnThisMachine(config),
  memoryDirectoriesForRepeats: (config) => productionMemoryDirectoriesForRepeats(config),
  resolveProjectMemoryDirectory: productionProjectMemoryDirectory,
  readStdin: () => readStreamAsText(process.stdin),
  projectMemoryDirectoriesToLint: () => projectMemoryDirectoriesToLint(homedir()),
  seedRepositories: () => repositoriesOfProjectMemoryDirectories(homedir()),
  currentDirectory: () => process.cwd(),
  dataDirectory: productionRecallDataDirectory(),
  agentLedgerDirectory: RUNTIME_DATA_DIR,
  get jevDataHome() {
    return jevDataHomeOfThisMachine();
  },
  now: () => new Date(),
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

async function writePromptToPromptLog(
  request: RecallRequest,
  promptKind: PromptKind,
  scope: RecallScope,
  at: Date,
  correction: CorrectionVerdict | undefined,
  dependencies: RecallDependencies,
): Promise<void> {
  try {
    await appendPromptToPromptLog(dependencies.dataDirectory, {
      sessionId: request.sessionId,
      taskText: request.taskText,
      promptKind,
      searchedMemoryDirectories: searchedMemoryDirectoriesOf(scope),
      transcriptPath: request.transcriptPath,
      correction,
      at,
    });
  } catch (error) {
    dependencies.writeStderr(
      `recall: the prompt could not be written to the prompt log: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function runRecallForHook(
  dependencies: RecallDependencies,
): Promise<number> {
  const startedAt = performance.now();
  let sessionId: string | undefined;
  try {
    const request = recallRequestFromHookPayload(await dependencies.readStdin());
    sessionId = request.sessionId;
    const config = await dependencies.loadConfig();
    if (!config.hookEnabled) {
      await recordSkippedHookRun(sessionId, HOOK_DISABLED, startedAt, dependencies);
      return 0;
    }
    if (isSkippedHookPayload(request)) {
      await recordSkippedHookRun(sessionId, request.skipReason, startedAt, dependencies);
      return 0;
    }
    const promptKind = promptKindOf(request.taskText);
    const decidedAt = dependencies.now();
    const scope = await recallScopeOf(request, config, dependencies);
    let correction: CorrectionVerdict | undefined;
    try {
      correction = await recallForPrompt(
        request,
        scope,
        config,
        config.hookTimeoutMilliseconds,
        {
          source: HOOK_SOURCE,
          arm: armForPrompt(
            config.hookMode,
            request.sessionId,
            inputHash(request.taskText),
          ),
          hookMode: config.hookMode,
          decidedAt,
          hookPrompt: { promptKind, startedAt },
        },
        dependencies,
      );
    } finally {
      await writePromptToPromptLog(request, promptKind, scope, decidedAt, correction, dependencies);
    }
  } catch (error) {
    dependencies.writeStderr(
      `recall: the hook served nothing: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await recordSkippedHookRun(sessionId, HOOK_FAILED, startedAt, dependencies);
  }
  return 0;
}

function refuseEntrance(reason: string, dependencies: RecallDependencies): number {
  dependencies.writeStderr(USAGE);
  dependencies.writeStderr(
    `${renderEntranceRefusal({
      reason: `recall entrance validation refused: ${reason}.`,
      bypass: undefined,
      supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
    })}\n`,
  );
  return 2;
}

async function recordVerdictOnTheJudge(
  verdict: SpotCheckVerdict,
  dependencies: RecallDependencies,
): Promise<number> {
  const gradedPrompts = await gradedPromptsIn(dependencies.dataDirectory);
  if (!gradedPrompts.some((gradedPrompt) => gradedPrompt.id === verdict.id)) {
    return refuseEntrance(
      `no graded prompt has the id ${verdict.id}; --spot-check prints the ids you can agree or disagree with`,
      dependencies,
    );
  }
  await appendSpotCheckVerdict(dependencies.dataDirectory, verdict, dependencies.now());
  dependencies.writeStdout(`recall: recorded that you ${verdict.verdict} with the judge on ${verdict.id}\n`);
  return 0;
}

function lintedMemoryDirectoriesOf(scope: RecallScope): readonly LintedMemoryDirectory[] {
  return [
    ...resolvedMemoryDirectoriesOf(scope).map(({ path: memoryDirectory, repositoryName }) => ({
      path: memoryDirectory,
      repositoryName,
    })),
    ...scope.globalMemoryDirectories.map((memoryDirectory) => ({ path: memoryDirectory, repositoryName: undefined })),
  ];
}

function namesNoLintScope(request: AskLintRequest): boolean {
  return request.directories.length === 0 && !request.includesGlobalMemories;
}

async function printAskLint(request: AskLintRequest, dependencies: RecallDependencies): Promise<number> {
  let directories: readonly LintedMemoryDirectory[];
  if (namesNoLintScope(request)) {
    directories = await dependencies.projectMemoryDirectoriesToLint();
  } else {
    const scope = await recallScopeOf(
      { directories: request.directories, memoryDirectories: [], includeGlobal: request.includesGlobalMemories },
      await dependencies.loadConfig(),
      dependencies,
    );
    const unresolvedRepositories = unresolvedRepositoriesOf(scope);
    if (unresolvedRepositories.length > 0) {
      return refuseEntrance(
        `no memory directory could be found for --directory ${unresolvedRepositories.join(', ')}`,
        dependencies,
      );
    }
    directories = lintedMemoryDirectoriesOf(scope);
  }
  const result = await lintAsks(directories);
  for (const violation of result.violations) dependencies.writeStdout(renderedAskViolation(violation));
  dependencies.writeStderr(renderedAskLintSummary(result));
  return result.violations.length === 0 ? 0 : 1;
}

export async function runRecall(
  commandArguments: readonly string[],
  dependencies: RecallDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: ParsedRecallArguments;
  try {
    parsed = parseRecallArguments(commandArguments, dependencies.currentDirectory());
  } catch (error) {
    if (commandArguments.includes('--hook')) return 0;
    return refuseEntrance(error instanceof Error ? error.message : String(error), dependencies);
  }
  if (parsed.hook) return runRecallForHook(dependencies);
  if (parsed.lintAsks !== undefined) return printAskLint(parsed.lintAsks, dependencies);
  if (parsed.report) {
    await printRecallReport(parsed.since, dependencies);
    return 0;
  }
  if (parsed.spotCheckCount !== undefined) {
    await printSpotCheck(parsed.spotCheckCount, dependencies);
    return 0;
  }
  if (parsed.spotCheckVerdict !== undefined) {
    return recordVerdictOnTheJudge(parsed.spotCheckVerdict, dependencies);
  }
  const config = await dependencies.loadConfig();
  if (parsed.status) {
    dependencies.writeStdout(
      renderedJevStatus(
        await dependencies.readJevSwitch(config),
        await dependencies.readJevSpending(config),
      ),
    );
    return 0;
  }
  const request: RecallRequest = {
    taskText: parsed.taskText as string,
    ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
    directories: parsed.directories,
    memoryDirectories: parsed.memoryDirectories,
    includeGlobal: parsed.includeGlobal,
  };
  const scope = await recallScopeOf(request, config, dependencies);
  const unresolvedRepositories = unresolvedRepositoriesOf(scope);
  if (unresolvedRepositories.length > 0) {
    return refuseEntrance(
      `no memory directory could be found for --directory ${unresolvedRepositories.join(', ')}`,
      dependencies,
    );
  }
  await recallForPrompt(
    request,
    scope,
    config,
    undefined,
    {
      source: COMMAND_SOURCE,
      arm: SERVE_ARM,
      decidedAt: dependencies.now(),
      outputFormat: parsed.json === true ? JSON_OUTPUT : TEXT_OUTPUT,
    },
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
