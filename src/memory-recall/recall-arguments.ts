import { AGREE, DISAGREE, type SpotCheckVerdict } from './spot-check-verdicts.ts';
import { PROMPTS_SPOT_CHECKED_BY_DEFAULT } from './spot-check.ts';

export interface AskLintRequest {
  readonly directories: readonly string[];
  readonly includesGlobalMemories: boolean;
}

export interface ParsedRecallArguments {
  readonly hook: boolean;
  readonly status: boolean;
  readonly report: boolean;
  readonly since?: Date;
  readonly taskText?: string;
  readonly sessionId?: string;
  readonly directories: readonly string[];
  readonly memoryDirectories: readonly string[];
  readonly includeGlobal: boolean;
  readonly json?: boolean;
  readonly spotCheckCount?: number;
  readonly spotCheckVerdict?: SpotCheckVerdict;
  readonly lintAsks?: AskLintRequest;
}

type SpotCheckVerdictFlag = Omit<SpotCheckVerdict, 'reason'>;

interface SpotCheckFlags {
  readonly spotCheck: boolean;
  readonly count: number | undefined;
  readonly verdicts: readonly SpotCheckVerdictFlag[];
}

const FLAGS_WITH_A_VALUE = new Set([
  '--session',
  '--directory',
  '--memory-dir',
  '--since',
  '--count',
  '--agree',
  '--disagree',
]);
const NO_SCOPE = { directories: [], memoryDirectories: [], includeGlobal: true } as const;
const NO_MODE = { hook: false, status: false, report: false, ...NO_SCOPE } as const;

function parsedSince(value: string): Date {
  const since = new Date(value);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`--since needs an ISO date or date-time (got "${value}")`);
  }
  return since;
}

function parsedCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--count needs a whole number above zero (got "${value}")`);
  }
  return count;
}

function isSpotCheckRequest(flags: SpotCheckFlags): boolean {
  return flags.spotCheck || flags.verdicts.length > 0;
}

function spotCheckArgumentsOf(flags: SpotCheckFlags, taskText: string): ParsedRecallArguments {
  if (flags.spotCheck) {
    if (taskText.length > 0) throw new Error('--spot-check takes no task text');
    return { ...NO_MODE, spotCheckCount: flags.count ?? PROMPTS_SPOT_CHECKED_BY_DEFAULT };
  }
  const verdict = flags.verdicts[0] as SpotCheckVerdictFlag;
  if (verdict.verdict === DISAGREE && taskText.length === 0) {
    throw new Error('--disagree needs a reason: --disagree <id> "<reason>"');
  }
  return { ...NO_MODE, spotCheckVerdict: { ...verdict, reason: taskText.length > 0 ? taskText : null } };
}

interface AskLintFlags {
  readonly lintAsks: boolean;
  readonly includesGlobalMemories: boolean;
}

function askLintArgumentsOf(
  flags: AskLintFlags,
  directories: readonly string[],
  namesAnotherFlagOrTaskText: boolean,
): ParsedRecallArguments {
  if (!flags.lintAsks) throw new Error('--global only goes with --lint-asks');
  if (namesAnotherFlagOrTaskText) {
    throw new Error('--lint-asks takes no task text and no flag but --directory and --global');
  }
  return { ...NO_MODE, lintAsks: { directories, includesGlobalMemories: flags.includesGlobalMemories } };
}

function missingScopeReason(currentDirectory: string): string {
  return (
    'a hand recall must name what to search: pass --directory <repository or any path inside it> ' +
    'or --memory-dir <memory directory>, each repeatable; ' +
    `without them it would have assumed the current directory ${currentDirectory}`
  );
}

export function parseRecallArguments(
  commandArguments: readonly string[],
  currentDirectory: string,
): ParsedRecallArguments {
  let hook = false;
  let status = false;
  let report = false;
  let includeGlobal = true;
  let since: Date | undefined;
  let sessionId: string | undefined;
  let spotCheck = false;
  let lintAsks = false;
  let includesGlobalMemories = false;
  let json = false;
  let count: number | undefined;
  const verdicts: SpotCheckVerdictFlag[] = [];
  const directories: string[] = [];
  const memoryDirectories: string[] = [];
  const taskWords: string[] = [];
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === '--hook') hook = true;
    else if (argument === '--status') status = true;
    else if (argument === '--report') report = true;
    else if (argument === '--no-global') includeGlobal = false;
    else if (argument === '--spot-check') spotCheck = true;
    else if (argument === '--lint-asks') lintAsks = true;
    else if (argument === '--global') includesGlobalMemories = true;
    else if (argument === '--json') json = true;
    else if (FLAGS_WITH_A_VALUE.has(argument)) {
      const value = commandArguments[index + 1];
      if (value === undefined) throw new Error(`${argument} needs a value`);
      if (argument === '--session') sessionId = value;
      else if (argument === '--since') since = parsedSince(value);
      else if (argument === '--memory-dir') memoryDirectories.push(value);
      else if (argument === '--count') count = parsedCount(value);
      else if (argument === '--agree') verdicts.push({ id: value, verdict: AGREE });
      else if (argument === '--disagree') verdicts.push({ id: value, verdict: DISAGREE });
      else directories.push(value);
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`unknown flag "${argument}"`);
    } else taskWords.push(argument);
  }
  const taskText = taskWords.join(' ').trim();
  const namesAHandOnlyFlag = memoryDirectories.length > 0 || !includeGlobal || json;
  if (lintAsks || includesGlobalMemories) {
    const namesAnotherFlagOrTaskText =
      hook || status || report || spotCheck || namesAHandOnlyFlag || taskText.length > 0 ||
      [sessionId, since, count].some((value) => value !== undefined) || verdicts.length > 0;
    return askLintArgumentsOf({ lintAsks, includesGlobalMemories }, directories, namesAnotherFlagOrTaskText);
  }
  if (since !== undefined && !report) throw new Error('--since only goes with --report');
  if (count !== undefined && !spotCheck) throw new Error('--count only goes with --spot-check');
  const spotCheckFlags = { spotCheck, count, verdicts };
  if (isSpotCheckRequest(spotCheckFlags)) {
    const namesAnotherFlag =
      hook || status || report || sessionId !== undefined || directories.length > 0 || namesAHandOnlyFlag;
    if (namesAnotherFlag || Number(spotCheck) + verdicts.length > 1) {
      throw new Error('--spot-check, --agree and --disagree each go alone');
    }
    return spotCheckArgumentsOf(spotCheckFlags, taskText);
  }
  if ((hook || status || report) && namesAHandOnlyFlag) {
    throw new Error('--memory-dir, --no-global and --json only go with a hand recall');
  }
  if (report) {
    if (hook || taskText.length > 0) throw new Error('--report takes no task text and no --hook');
    return { hook: false, status: false, report, ...NO_SCOPE, ...(since === undefined ? {} : { since }) };
  }
  if (status) return { hook: false, status, report, ...NO_SCOPE };
  if (hook) {
    if (taskText.length > 0) throw new Error('--hook reads the task from stdin and takes no task text');
    return { hook, status, report, ...NO_SCOPE };
  }
  if (taskText.length === 0) throw new Error('the task text is required: say what the work is about');
  if (directories.length === 0 && memoryDirectories.length === 0) {
    throw new Error(missingScopeReason(currentDirectory));
  }
  return { hook, status, report, taskText, sessionId, directories, memoryDirectories, includeGlobal, json };
}
