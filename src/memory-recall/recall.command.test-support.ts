import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NO, type ClassifierBackend } from '../relevance-classifier/classifier.types.ts';
import { chooseClassifierBackend } from '../relevance-classifier/choose-backend.ts';
import type { JevBackendDependencies } from '../relevance-classifier/jev-backend.ts';
import { readJevSpending } from '../relevance-classifier/jev-spending.ts';
import {
  DEFAULT_RECALL_CONFIG,
  jevLimitsOf,
  type RecallConfig,
} from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND } from '../relevance-classifier/rules-backend.ts';
import type { RecallDependencies } from './recall.command.ts';
import { RECALL_LEDGER_FILE_NAME } from './recall-records.ts';
import type { RegisteredRepository } from './repository-registry.ts';

export const PROJECT_SCOPE = '-home-someone-project';

export const PULL_REQUEST_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  `scope: ${PROJECT_SCOPE}`,
  'kind: trap',
  'cost_if_missed: high',
  '---',
  '# Never republish a pull request body from a local file',
  '',
  '- it grows by a newline each time',
].join('\n');

export const SUPERSEDED_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  'status: superseded',
  'superseded_by: NEVER_REPUBLISH.md',
  '---',
  'an outdated pull request description lesson',
].join('\n');

export const OTHER_REPOSITORY_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  'scope: -home-someone-elsewhere',
  '---',
  'a pull request description lesson for another repository',
].join('\n');

export const OTHER_REPOSITORY_NAME = 'other-repository';
export const OTHER_REPOSITORY_SCOPE = '-home-someone-other-repository';

export const OTHER_REPOSITORY_PULL_REQUEST_MEMORY = [
  '---',
  'ask: Does the task edit a GitHub pull request description?',
  `scope: ${OTHER_REPOSITORY_SCOPE}`,
  '---',
  'the other repository fills in its pull request template first',
].join('\n');

export const WIFI_MEMORY = '# Guard temporary wifi router changes\n\n- put the network back\n';

export interface Harness {
  readonly dependencies: RecallDependencies;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly dataDirectory: string;
  readonly jevDataHome: string;
  readonly projectMemories: string;
  readonly otherRepositoryMemories: string;
  readonly globalMemories: string;
  readonly currentDirectory: string;
  backendCallCount(): number;
}

export const IN_PROJECT = ['--directory', 'project'] as const;
export const IN_OTHER_REPOSITORY = ['--directory', OTHER_REPOSITORY_NAME] as const;

export function harness(
  configOverride: Partial<RecallConfig> = {},
  options: {
    stdin?: string;
    backend?: ClassifierBackend;
    jevBehindTheBudget?: JevBackendDependencies;
    seededRepositories?: readonly RegisteredRepository[];
  } = {},
): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-command-'));
  const projectMemories = path.join(root, 'project-memories');
  const otherRepositoryMemories = path.join(root, OTHER_REPOSITORY_SCOPE);
  const globalMemories = path.join(root, 'global-memories');
  const dataDirectory = path.join(root, 'data');
  const jevDataHome = path.join(root, 'jev-data-home');
  const now = new Date('2026-09-21T00:00:00Z');
  mkdirSync(projectMemories);
  mkdirSync(otherRepositoryMemories);
  mkdirSync(globalMemories);
  writeFileSync(path.join(otherRepositoryMemories, 'PULL_REQUEST_TEMPLATE.md'), OTHER_REPOSITORY_PULL_REQUEST_MEMORY);
  writeFileSync(path.join(projectMemories, 'NEVER_REPUBLISH.md'), PULL_REQUEST_MEMORY);
  writeFileSync(path.join(projectMemories, 'OLD_LESSON.md'), SUPERSEDED_MEMORY);
  writeFileSync(path.join(projectMemories, 'MEMORY.md'), '# index mentioning github pull request description');
  writeFileSync(path.join(globalMemories, 'ELSEWHERE.md'), OTHER_REPOSITORY_MEMORY);
  writeFileSync(path.join(globalMemories, 'NETWORK_SAFETY.md'), WIFI_MEMORY);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let backendCalls = 0;
  const backend = options.backend ?? RULES_BACKEND;
  return {
    stdout,
    stderr,
    dataDirectory,
    jevDataHome,
    projectMemories,
    otherRepositoryMemories,
    globalMemories,
    currentDirectory: root,
    backendCallCount: () => backendCalls,
    dependencies: {
      loadConfig: () =>
        Promise.resolve({
          ...DEFAULT_RECALL_CONFIG,
          globalMemoryDirectories: [globalMemories],
          ...configOverride,
        }),
      chooseBackend: (config, caller) => {
        const jevBehindTheBudget = options.jevBehindTheBudget;
        if (jevBehindTheBudget !== undefined) {
          return chooseClassifierBackend(config, caller, {
            jevSwitch: { environment: {}, statKeyFile: () => Promise.resolve({ isFile: () => true, size: 14 }) },
            jevBackend: jevBehindTheBudget,
            jevDataHome,
            writeStderr: (text) => stderr.push(text),
          });
        }
        return Promise.resolve<ClassifierBackend>({
          name: backend.name,
          answer: (state, questions) => {
            backendCalls += 1;
            return backend.answer(state, questions);
          },
        });
      },
      memoryDirectoriesForRepeats: () => Promise.resolve([projectMemories, globalMemories]),
      readJevSwitch: () =>
        Promise.resolve({
          on: false,
          enabledInConfig: false,
          disabledByEnvironment: false,
          keyFile: 'not-checked',
          keyFilePath: '/keys/jev',
        }),
      readJevSpending: (config) => readJevSpending(jevDataHome, jevLimitsOf(config), now),
      resolveProjectMemoryDirectory: (directory) =>
        Promise.resolve(
          path.basename(directory) === OTHER_REPOSITORY_NAME
            ? {
                path: otherRepositoryMemories,
                checkout: path.join(root, OTHER_REPOSITORY_NAME),
                repositoryName: OTHER_REPOSITORY_NAME,
                repositoryScopes: [OTHER_REPOSITORY_SCOPE, OTHER_REPOSITORY_NAME],
              }
            : {
                path: projectMemories,
                checkout: path.join(root, 'project'),
                repositoryName: 'project',
                repositoryScopes: [PROJECT_SCOPE, 'project'],
              },
        ),
      readStdin: () => Promise.resolve(options.stdin ?? ''),
      projectMemoryDirectoriesToLint: () =>
        Promise.resolve([{ path: projectMemories, repositoryName: 'project' }]),
      seedRepositories: () => Promise.resolve(options.seededRepositories ?? []),
      currentDirectory: () => root,
      dataDirectory,
      agentLedgerDirectory: path.join(root, 'agents'),
      jevDataHome,
      now: () => now,
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

export function ledgerLines(dataDirectory: string): Record<string, unknown>[] {
  return readFileSync(path.join(dataDirectory, RECALL_LEDGER_FILE_NAME), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function ledgerEntries(dataDirectory: string): Record<string, unknown>[] {
  return ledgerLines(dataDirectory).filter((line) => 'questionId' in line);
}

export function isCompactAnswerLine(line: Record<string, unknown>): boolean {
  return 'questionId' in line && !('backend' in line);
}

export const COMPACT_ANSWER_LINE_KEYS = ['at', 'inputHash', 'questionId', 'pick', 'probability'];

export function assertEveryAnswerWasLogged(dataDirectory: string): void {
  const lines = ledgerLines(dataDirectory);
  const [summary] = lines.filter((line) => 'questionsAsked' in line);
  assert.equal(summary?.everyAnswerLogged, true);
  assert.equal(summary?.confidentNoAnswersLeftOut, 0);
  assert.equal(ledgerEntries(dataDirectory).length, summary?.questionsAsked);
  const compactLines = lines.filter(isCompactAnswerLine);
  assert.deepEqual(
    compactLines.map((line) => [Object.keys(line), line.at, line.inputHash, line.pick]),
    [[COMPACT_ANSWER_LINE_KEYS, summary?.at, summary?.inputHash, NO]],
  );
  assert.match(String(compactLines[0]?.questionId), /NETWORK_SAFETY\.md$/);
}

export const PULL_REQUEST_TASK = 'rewrite the github pull request description for the fix';

export const HOOK_PAYLOAD = JSON.stringify({
  session_id: 'abc',
  cwd: '/somewhere',
  hook_event_name: 'UserPromptSubmit',
  prompt: PULL_REQUEST_TASK,
});

export function sureNoBackend(probabilityOfNo: number): ClassifierBackend {
  return {
    name: 'jev',
    answer: async (_state, questions) =>
      questions.map((question) => ({
        questionId: question.id,
        pick: NO,
        probability: probabilityOfNo,
      })),
  };
}
