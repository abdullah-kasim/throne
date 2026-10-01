import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { wasSent } from '../memory-recall/recall-report-jev-spend.ts';
import { answeredByLabel } from '../memory-recall/recall-verdict.ts';
import { answeringBackendOf } from '../relevance-classifier/answering-backend.ts';
import {
  PRODUCTION_BACKEND_CHOICE_DEPENDENCIES,
  chooseClassifierBackend,
  type BackendChoiceDependencies,
} from '../relevance-classifier/choose-backend.ts';
import {
  NO,
  yesOrNoQuestion,
  type ClassifierAnswer,
  type ClassifierBackend,
  type FailOpenQuestion,
} from '../relevance-classifier/classifier.types.ts';
import { askFailingOpen } from '../relevance-classifier/fail-open-classifier.ts';
import { estimatedRequestTokens, stateWithinJevLimit } from '../relevance-classifier/jev-backend.ts';
import { readJevSpending, renderedJevSpending, type JevSpending } from '../relevance-classifier/jev-spending.ts';
import { readJevSwitch, reasonJevIsOff } from '../relevance-classifier/jev-switch.ts';
import { readJevUsageLines, type JevCallerKind, type JevUsageLine } from '../relevance-classifier/jev-usage-log.ts';
import { jevLimitsOf, loadRecallConfig, type RecallConfig } from '../relevance-classifier/recall-user-config.ts';
import { RULES_BACKEND, meaningfulWords } from '../relevance-classifier/rules-backend.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';
import {
  MOST_RUNS_PER_PROBE,
  parseJevProbeArguments,
  type JevProbeArguments,
  type ProbeStateSource,
} from './jev-probe-arguments.ts';

const PROBE_CALLER: JevCallerKind = 'probe';
const PROBE_QUESTION_ID = 'probe';
const NEVER_OVERRIDE_THE_PICK = 1;

export interface JevProbeDependencies {
  loadConfig(): Promise<RecallConfig>;
  readStateFile(filePath: string): Promise<string>;
  readonly backendChoice: BackendChoiceDependencies;
  writeStdout(text: string): void;
  writeStderr(text: string): void;
}

const PRODUCTION_DEPENDENCIES: JevProbeDependencies = {
  loadConfig: () => loadRecallConfig(),
  readStateFile: (filePath) => readFile(filePath, 'utf8'),
  backendChoice: PRODUCTION_BACKEND_CHOICE_DEPENDENCIES,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export const USAGE =
  'Usage: throne jev-probe --question "<yes/no question>" (--state "<text>" | --state-file <path>) [--repeat N] [--json]\n' +
  'Asks Jev one yes/no question about one state through the same budgeted path recall, rank and sift use:\n' +
  'the only sanctioned way to test a Jev wording. It first prints the estimated tokens of the whole call and\n' +
  "what is left of today's and this hour's budget, and refuses, sending nothing, when the call would not fit.\n" +
  `Each run is charged. --repeat defaults to 1 and is capped at ${MOST_RUNS_PER_PROBE}.\n`;

interface BudgetLeft {
  readonly todayTokens: number;
  readonly lastHourTokens: number;
}

interface ProbeRun {
  readonly pick: string;
  readonly probability: number;
  readonly answeredBy: string;
}

interface ProbeCharge {
  readonly reservedTokens: number;
  readonly spentTokens: number;
}

function budgetLeftOf(spending: JevSpending): BudgetLeft {
  return {
    todayTokens: Math.max(0, spending.limits.tokensPerDay - spending.spend.todayTokens),
    lastHourTokens: Math.max(0, spending.limits.tokensPerHour - spending.spend.lastHourTokens),
  };
}

function probeQuestion(question: string): FailOpenQuestion {
  return {
    ...yesOrNoQuestion(PROBE_QUESTION_ID, question, {
      kind: 'any-phrase',
      phrases: [...meaningfulWords(question)],
    }),
    safePick: NO,
    minimumProbabilityOfSafePick: NEVER_OVERRIDE_THE_PICK,
  };
}

function estimatedTokensPerRun(state: string, question: FailOpenQuestion): number {
  return estimatedRequestTokens(stateWithinJevLimit(state, [question]), [question]);
}

function budgetShortfallOf(estimatedTokens: number, left: BudgetLeft): string | undefined {
  if (estimatedTokens > left.todayTokens) {
    return `the whole call needs about ${estimatedTokens} tokens and only ${left.todayTokens} are left today`;
  }
  if (estimatedTokens > left.lastHourTokens) {
    return `the whole call needs about ${estimatedTokens} tokens and only ${left.lastHourTokens} are left in the last hour`;
  }
  return undefined;
}

function chargedTokens(line: JevUsageLine): number {
  return line.realTokens ?? line.estimatedTokens;
}

function probeChargeOf(lines: readonly JevUsageLine[], invocationId: string): ProbeCharge {
  const sentProbeLines = lines.filter((line) => line.invocationId === invocationId && wasSent(line));
  return {
    reservedTokens: sentProbeLines.reduce((total, line) => total + line.estimatedTokens, 0),
    spentTokens: sentProbeLines.reduce((total, line) => total + chargedTokens(line), 0),
  };
}

async function askOnce(
  backend: ClassifierBackend,
  state: string,
  question: FailOpenQuestion,
  dependencies: JevProbeDependencies,
): Promise<ProbeRun> {
  const answers = await askFailingOpen(
    backend,
    state,
    [question],
    { writeStderr: dependencies.writeStderr },
    { backendWhenTheFirstFails: RULES_BACKEND },
  );
  const answer = answers[0] as ClassifierAnswer;
  return {
    pick: answer.pick,
    probability: answer.probability,
    answeredBy: answeredByLabel(answeringBackendOf(answers), { confidence: answer.probability }),
  };
}

function renderedCost(runs: number, tokensPerRun: number, spending: JevSpending): string {
  return [
    `jev-probe: ${runs} run(s) of about ${tokensPerRun} estimated tokens each, ${runs * tokensPerRun} in all`,
    ...renderedJevSpending(spending),
    '',
  ].join('\n');
}

function renderedRun(runNumber: number, run: ProbeRun): string {
  return `run ${runNumber}: ${run.pick}, probability ${run.probability.toFixed(3)}, answered by ${run.answeredBy}\n`;
}

function renderedCharge(charge: ProbeCharge, spending: JevSpending): string {
  return [
    `tokens reserved: ${charge.reservedTokens}, spent: ${charge.spentTokens}`,
    ...renderedJevSpending(spending),
    '',
  ].join('\n');
}

function refused(reason: string, dependencies: JevProbeDependencies): number {
  dependencies.writeStderr(`jev-probe: refused, nothing was sent: ${reason}.\n`);
  return 1;
}

async function probeStateOf(source: ProbeStateSource, dependencies: JevProbeDependencies): Promise<string> {
  return source.kind === 'text' ? source.text : dependencies.readStateFile(source.filePath);
}

function entranceRefused(reason: string, dependencies: JevProbeDependencies): number {
  dependencies.writeStderr(USAGE);
  dependencies.writeStderr(
    `${renderEntranceRefusal({
      reason: `jev-probe entrance validation refused: ${reason}.`,
      bypass: undefined,
      supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
    })}\n`,
  );
  return 2;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probeWithinTheBudget(
  parsed: JevProbeArguments,
  state: string,
  dependencies: JevProbeDependencies,
): Promise<number> {
  const config = await dependencies.loadConfig();
  const jevSwitch = await readJevSwitch(config, dependencies.backendChoice.jevSwitch);
  if (!jevSwitch.on) return refused(`Jev is off because ${reasonJevIsOff(jevSwitch)}`, dependencies);
  const question = probeQuestion(parsed.question);
  const tokensPerRun = estimatedTokensPerRun(state, question);
  const estimatedTokens = parsed.runs * tokensPerRun;
  const dataHome = dependencies.backendChoice.jevDataHome;
  const limits = jevLimitsOf(config);
  const spendingBefore = await readJevSpending(dataHome, limits, new Date());
  if (!parsed.json) dependencies.writeStdout(renderedCost(parsed.runs, tokensPerRun, spendingBefore));
  const shortfall = budgetShortfallOf(estimatedTokens, budgetLeftOf(spendingBefore));
  if (shortfall !== undefined) return refused(shortfall, dependencies);
  const invocationId = randomUUID();
  const backend = await chooseClassifierBackend(config, PROBE_CALLER, dependencies.backendChoice, invocationId);
  const runs: ProbeRun[] = [];
  for (let runNumber = 1; runNumber <= parsed.runs; runNumber += 1) {
    const run = await askOnce(backend, state, question, dependencies);
    runs.push(run);
    if (!parsed.json) dependencies.writeStdout(renderedRun(runNumber, run));
  }
  const charge = probeChargeOf((await readJevUsageLines(dataHome)).lines, invocationId);
  const spendingAfter = await readJevSpending(dataHome, limits, new Date());
  dependencies.writeStdout(
    parsed.json
      ? `${JSON.stringify({
          estimatedTokens,
          leftBefore: budgetLeftOf(spendingBefore),
          runs,
          ...charge,
          leftAfter: budgetLeftOf(spendingAfter),
        })}\n`
      : renderedCharge(charge, spendingAfter),
  );
  return 0;
}

export async function runJevProbe(
  commandArguments: readonly string[],
  dependencies: JevProbeDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  let parsed: JevProbeArguments;
  let state: string;
  try {
    parsed = parseJevProbeArguments(commandArguments);
    state = await probeStateOf(parsed.stateSource, dependencies);
  } catch (error) {
    return entranceRefused(messageOf(error), dependencies);
  }
  return probeWithinTheBudget(parsed, state, dependencies);
}
