export const MOST_RUNS_PER_PROBE = 5;

export type ProbeStateSource =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly filePath: string };

export interface JevProbeArguments {
  readonly question: string;
  readonly stateSource: ProbeStateSource;
  readonly runs: number;
  readonly json: boolean;
}

function valueAfter(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function runCountOf(value: string): number {
  const runs = Number(value);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new Error(`--repeat must be a whole number of at least 1 (got ${value})`);
  }
  if (runs > MOST_RUNS_PER_PROBE) {
    throw new Error(`--repeat is capped at ${MOST_RUNS_PER_PROBE} (got ${value})`);
  }
  return runs;
}

function stateSourceOf(stateText: string | undefined, stateFilePath: string | undefined): ProbeStateSource {
  if (stateText !== undefined && stateFilePath !== undefined) {
    throw new Error('give the state once: --state or --state-file, not both');
  }
  if (stateText !== undefined) return { kind: 'text', text: stateText };
  if (stateFilePath !== undefined) return { kind: 'file', filePath: stateFilePath };
  throw new Error('the state is required: --state "<text>" or --state-file <path>');
}

export function parseJevProbeArguments(commandArguments: readonly string[]): JevProbeArguments {
  let question: string | undefined;
  let stateText: string | undefined;
  let stateFilePath: string | undefined;
  let runs = 1;
  let json = false;
  for (let index = 0; index < commandArguments.length; index += 1) {
    const argument = commandArguments[index] as string;
    if (argument === '--json') json = true;
    else if (argument === '--question') question = valueAfter(argument, commandArguments[(index += 1)]);
    else if (argument === '--state') stateText = valueAfter(argument, commandArguments[(index += 1)]);
    else if (argument === '--state-file') stateFilePath = valueAfter(argument, commandArguments[(index += 1)]);
    else if (argument === '--repeat') runs = runCountOf(valueAfter(argument, commandArguments[(index += 1)]));
    else if (argument.startsWith('--')) throw new Error(`unknown flag "${argument}"`);
    else throw new Error(`unexpected argument "${argument}": pass the question with --question`);
  }
  if (question === undefined) {
    throw new Error('the yes/no question is required: --question "<yes/no question>"');
  }
  return { question, stateSource: stateSourceOf(stateText, stateFilePath), runs, json };
}
