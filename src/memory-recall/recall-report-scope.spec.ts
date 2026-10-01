import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  SERVE_ARM,
  SHADOW_ARM,
  SPLIT_HOOK_MODE,
  type RecallArm,
} from '../relevance-classifier/recall-user-config.ts';
import { HOOK_SOURCE, PROMPT_LOG_FILE_NAME, RECALL_LEDGER_FILE_NAME, inputHash } from './recall-records.ts';
import { MEMORY_READ_LOG_FILE_NAME } from './recall-report-logs.ts';
import { OTHER_REPOSITORY_LEDGER_FIELD } from './other-repositories-records.ts';
import { REPORT_TIME, topicBackend } from './recall-report.test-support.ts';
import { NO_RELEVANT_MEMORY } from './recall-verdict.ts';
import { runRecall } from './recall.command.ts';
import { harness } from './recall.command.test-support.ts';

const REPOSITORIES = ['bakery', 'florist', 'tailor'] as const;
type Repository = (typeof REPOSITORIES)[number];

const MEMORY_TEXTS: Readonly<Record<string, string>> = {
  'bakery/OVEN.md': '# Preheat the oven before the dough rests topic-oven\n',
  'florist/VASE.md': '# Rinse every vase before filling topic-vase\n',
  'florist/SHOP_HOURS.md': '# The shop opens late on Mondays topic-shop\n',
  'tailor/HEM.md': '# Pin a hem before sewing it topic-hem\n',
  'tailor/SHOP_SIGN.md': '# Turn the shop sign at closing topic-shop\n',
  'global/APRON.md': '# Wash aprons after every shift topic-apron\n',
};

type Step =
  | { readonly read: string }
  | { readonly recall: readonly string[] };

interface ScopePrompt {
  readonly label: string;
  readonly topic: string;
  readonly arm: RecallArm;
  readonly confidence: number;
  readonly recordsItsScope: boolean;
  readonly steps: readonly Step[];
  readonly fromAWorktreeSinceReapedIn?: Repository;
  readonly otherRepositoriesAnswered?: readonly { readonly repository: Repository; readonly listed: boolean }[];
}

const REAPED_AGENT_NAME = 'shadow-tailoring-01';

const FROM_A_REAPED_WORKTREE: ScopePrompt = {
  label: 'BEFORE_SCOPES_FROM_A_REAPED_WORKTREE',
  topic: 'hem',
  arm: SHADOW_ARM,
  confidence: 0.52,
  recordsItsScope: false,
  steps: [{ read: 'tailor/HEM.md' }],
  fromAWorktreeSinceReapedIn: 'tailor',
};

const PROMPTS: readonly ScopePrompt[] = [
  { label: 'IN_SCOPE', topic: 'oven', arm: SERVE_ARM, confidence: 0.95, recordsItsScope: true, steps: [{ read: 'bakery/OVEN.md' }] },
  {
    label: 'NEIGHBOUR',
    topic: 'vase',
    arm: SERVE_ARM,
    confidence: 0.95,
    recordsItsScope: true,
    steps: [{ read: 'florist/VASE.md' }],
    otherRepositoriesAnswered: [{ repository: 'florist', listed: true }],
  },
  {
    label: 'ASKED_FIRST',
    topic: 'vase',
    arm: SERVE_ARM,
    confidence: 0.95,
    recordsItsScope: true,
    steps: [{ recall: ['--directory', '../../florist', 'arrange the vases'] }, { read: 'florist/VASE.md' }],
  },
  {
    label: 'ASKED_LATE',
    topic: 'hem',
    arm: SERVE_ARM,
    confidence: 0.95,
    recordsItsScope: true,
    steps: [{ read: 'tailor/HEM.md' }, { recall: ['--directory', '../../tailor', 'sew the hem'] }],
    otherRepositoriesAnswered: [
      { repository: 'florist', listed: true },
      { repository: 'tailor', listed: false },
    ],
  },
  {
    label: 'BEFORE_SCOPES_ELSEWHERE',
    topic: 'shop',
    arm: SHADOW_ARM,
    confidence: 0.52,
    recordsItsScope: false,
    steps: [{ read: 'florist/SHOP_HOURS.md' }, { read: 'tailor/SHOP_SIGN.md' }],
  },
  { label: 'BEFORE_SCOPES_AT_HOME', topic: 'oven', arm: SHADOW_ARM, confidence: 0.52, recordsItsScope: false, steps: [{ read: 'bakery/OVEN.md' }] },
  { label: 'BEFORE_SCOPES_GLOBAL', topic: 'apron', arm: SHADOW_ARM, confidence: 0.52, recordsItsScope: false, steps: [{ read: 'global/APRON.md' }] },
];

function jsonLines(lines: readonly object[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join('');
}

function minuteOf(promptIndex: number, stepIndex: number): string {
  return `2026-10-01T10:${String(promptIndex * 5 + stepIndex).padStart(2, '0')}:00.000Z`;
}

async function reportOnScopedDigs(prompts: readonly ScopePrompt[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'recall-report-scope-'));
  const memories = path.join(root, 'memories');
  const repositories = path.join(root, 'repositories');
  const dataDirectory = path.join(root, 'data');
  const agentLedgerDirectory = path.join(root, 'agents');
  const sessionDirectory = path.join(repositories, 'bakery', 'worktree');
  const reapedWorktreeDirectory = path.join(root, 'worktrees', REAPED_AGENT_NAME);
  for (const directory of [...REPOSITORIES, 'global']) mkdirSync(path.join(memories, directory), { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  mkdirSync(dataDirectory);
  for (const [memory, text] of Object.entries(MEMORY_TEXTS)) writeFileSync(path.join(memories, memory), text);
  for (const prompt of prompts) {
    if (prompt.fromAWorktreeSinceReapedIn === undefined) continue;
    const reapedLedger = path.join(agentLedgerDirectory, '.reaped', REAPED_AGENT_NAME);
    mkdirSync(reapedLedger, { recursive: true });
    writeFileSync(
      path.join(reapedLedger, 'tree-base.json'),
      JSON.stringify({ name: REAPED_AGENT_NAME, repo: path.join(repositories, prompt.fromAWorktreeSinceReapedIn) }),
    );
  }
  const memoryDirectoryOf = (repository: Repository | 'global') => path.join(memories, repository);
  const promptTextOf = (prompt: ScopePrompt) => `${prompt.label}: fix the topic-${prompt.topic} problem`;
  const summaryOf = (prompt: ScopePrompt, index: number) => ({
    at: minuteOf(index, 0),
    inputHash: inputHash(promptTextOf(prompt)),
    source: HOOK_SOURCE,
    sessionId: prompt.label,
    arm: prompt.arm,
    hookMode: SPLIT_HOOK_MODE,
    verdict: NO_RELEVANT_MEMORY,
    verdictConfidence: prompt.confidence,
    ...(prompt.recordsItsScope
      ? { searchedMemoryDirectories: [memoryDirectoryOf('bakery'), memoryDirectoryOf('global')] }
      : {}),
    questionsAsked: 3,
    served: 0,
    confidentNoAnswersLeftOut: 3,
  });
  const readOf = (prompt: ScopePrompt, index: number, step: Step, stepIndex: number) => ({
    at: minuteOf(index, stepIndex + 1),
    sessionId: prompt.label,
    ...('read' in step
      ? { kind: 'read', memoryFiles: [path.join(memories, step.read)], readInFull: true }
      : { kind: 'recall-command', memoryFiles: [], readInFull: false, recallArguments: step.recall }),
    returnedSomething: true,
    ...(prompt.fromAWorktreeSinceReapedIn === undefined
      ? { cwd: sessionDirectory }
      : { cwd: reapedWorktreeDirectory, agentName: REAPED_AGENT_NAME }),
  });
  const otherRepositoryLinesOf = (prompt: ScopePrompt, index: number) =>
    (prompt.otherRepositoriesAnswered ?? []).map(({ repository, listed }, rankIndex) => ({
      at: minuteOf(index, 0),
      inputHash: inputHash(promptTextOf(prompt)),
      [OTHER_REPOSITORY_LEDGER_FIELD]: path.join(repositories, repository),
      repositoryName: repository,
      memoryDirectory: memoryDirectoryOf(repository),
      pick: 'yes',
      probability: 0.8,
      backend: 'jev',
      failedOpen: false,
      rank: rankIndex + 1,
      listed,
    }));
  writeFileSync(
    path.join(dataDirectory, RECALL_LEDGER_FILE_NAME),
    jsonLines(prompts.flatMap((prompt, index) => [summaryOf(prompt, index), ...otherRepositoryLinesOf(prompt, index)])),
  );
  writeFileSync(
    path.join(dataDirectory, PROMPT_LOG_FILE_NAME),
    jsonLines(prompts.map((prompt, index) => ({ at: minuteOf(index, 0), sessionId: prompt.label, inputHash: inputHash(promptTextOf(prompt)), prompt: promptTextOf(prompt) }))),
  );
  writeFileSync(
    path.join(dataDirectory, MEMORY_READ_LOG_FILE_NAME),
    jsonLines(prompts.flatMap((prompt, index) => prompt.steps.map((step, stepIndex) => readOf(prompt, index, step, stepIndex)))),
  );
  const run = harness({ globalMemoryDirectories: [memoryDirectoryOf('global')] });
  await runRecall(['--report'], {
    ...run.dependencies,
    dataDirectory,
    agentLedgerDirectory,
    chooseBackend: () => Promise.resolve(topicBackend()),
    memoryDirectoriesForRepeats: () => Promise.resolve([]),
    resolveProjectMemoryDirectory: (directory) => {
      const repository = REPOSITORIES.find((name) => directory.split(path.sep).includes(name));
      return Promise.resolve(
        repository === undefined
          ? undefined
          : {
              path: memoryDirectoryOf(repository),
              checkout: path.join(path.sep, 'checkouts', repository),
              repositoryName: repository,
              repositoryScopes: [repository],
            },
      );
    },
    now: () => REPORT_TIME,
  });
  return run.stdout.join('');
}

const REPORT = reportOnScopedDigs(PROMPTS);
const REPORT_FROM_A_REAPED_WORKTREE = reportOnScopedDigs([FROM_A_REAPED_WORKTREE]);

function blockAfter(output: string, heading: string): string {
  return output.slice(output.indexOf(heading)).split('\n\n')[0] ?? '';
}

test('a dig that finds a relevant memory inside the searched scope counts as missed-and-found', async () => {
  const main = blockAfter(await REPORT, 'MAIN: ');
  assert.ok(main.includes('    serve arm: 25.0 per 100 prompts (1 of 4 prompts)\n'), main);
  assert.ok(main.includes('serve arm: "IN_SCOPE: fix the topic-oven problem" | Jev served: nothing | the dig found: OVEN.md'), main);
});

test('a dig that finds a relevant memory outside the searched scope is reported as an out-of-scope find and not as a miss', async () => {
  const output = await REPORT;
  const outOfScope = blockAfter(output, 'OUT OF SCOPE: ');
  assert.ok(outOfScope.includes('    serve arm: 75.0 per 100 prompts (3 of 4 prompts)'), outOfScope);
  const main = blockAfter(output, 'MAIN: ');
  for (const memory of ['VASE.md', 'HEM.md', 'SHOP_HOURS.md', 'SHOP_SIGN.md']) {
    assert.ok(!main.includes(memory), main);
  }
});

test('the out-of-scope line counts how often the agent first called throne recall with that repository\'s scope', async () => {
  const outOfScope = blockAfter(await REPORT, 'OUT OF SCOPE: ');
  assert.ok(
    outOfScope.includes("    serve arm: 75.0 per 100 prompts (3 of 4 prompts); 1 of 3 first ran throne recall with that repository's scope;"),
    outOfScope,
  );
});

test('the out-of-scope line counts the prompts whose out-of-scope find lay in a repository recall listed, and not one only asked about', async () => {
  const outOfScope = blockAfter(await REPORT, 'OUT OF SCOPE: ');
  assert.ok(
    outOfScope.includes(
      "    serve arm: 75.0 per 100 prompts (3 of 4 prompts); 1 of 3 first ran throne recall with that repository's scope; 1 of 3 had recall list that repository among the other repositories\n",
    ),
    outOfScope,
  );
});

test("verdict calibration leaves out a dig whose relevant finds all lie outside the verdict's scope", async () => {
  const calibration = blockAfter(await REPORT, 'BONUS: verdict calibration over prompts with a dig');
  assert.ok(
    calibration.includes(
      [
        '  "no relevant memory" was right:',
        '    confidence 0.5-0.6: 0 of 2',
        '    confidence 0.9-1.0: 0 of 1',
        '  "memory likely exists" was right:',
      ].join('\n'),
    ),
    calibration,
  );
  assert.ok(calibration.includes('(0 of 3 right over every confidence)'), calibration);
});

test('a ledger line recorded before scopes existed is read as the session\'s repository plus the global memories', async () => {
  const output = await REPORT;
  const main = blockAfter(output, 'MAIN: ');
  assert.ok(main.includes('    shadow arm: 66.7 per 100 prompts (2 of 3 prompts)\n'), main);
  assert.ok(main.includes('"BEFORE_SCOPES_AT_HOME: fix the topic-oven problem" | Jev served: nothing | the dig found: OVEN.md'), main);
  assert.ok(main.includes('"BEFORE_SCOPES_GLOBAL: fix the topic-apron problem" | Jev served: nothing | the dig found: APRON.md'), main);
  assert.ok(
    blockAfter(output, 'OUT OF SCOPE: ').includes(
      "    shadow arm: 33.3 per 100 prompts (1 of 3 prompts); 0 of 1 first ran throne recall with that repository's scope",
    ),
    output,
  );
});

test('a ledger line recorded before scopes existed, from a worktree that has since been removed, is read as that worktree\'s repository plus the global memories', async () => {
  const output = await REPORT_FROM_A_REAPED_WORKTREE;
  const main = blockAfter(output, 'MAIN: ');
  assert.ok(main.includes('    shadow arm: 100.0 per 100 prompts (1 of 1 prompts)\n'), main);
  assert.ok(main.includes('"BEFORE_SCOPES_FROM_A_REAPED_WORKTREE: fix the topic-hem problem" | Jev served: nothing | the dig found: HEM.md'), main);
  assert.ok(
    blockAfter(output, 'OUT OF SCOPE: ').includes(
      "    shadow arm: 0.0 per 100 prompts (0 of 1 prompts); 0 of 0 first ran throne recall with that repository's scope",
    ),
    output,
  );
});
