export interface McqArguments {
  readonly agentName: string;
  readonly action: { readonly kind: 'answer'; readonly optionNumber: number } | { readonly kind: 'dismiss' };
  readonly dryRun: boolean;
}

export const MCQ_USAGE =
  'usage: throne mcq --agent <name> (--answer <option number> | --dismiss) [--dry-run]';

const AGENT_FLAG = '--agent';
const ANSWER_FLAG = '--answer';
const DISMISS_FLAG = '--dismiss';
const DRY_RUN_FLAG = '--dry-run';

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new Error(`mcq: ${flag} requires a value`);
  }
  return value;
}

function parseOptionNumber(raw: string): number {
  if (!/^\d+$/u.test(raw)) throw new Error(`mcq: ${ANSWER_FLAG} takes an option number, got "${raw}"`);
  const number = Number(raw);
  if (number < 1) throw new Error(`mcq: ${ANSWER_FLAG} option numbers start at 1`);
  return number;
}

export function parseMcqArguments(args: readonly string[]): McqArguments {
  let agentName: string | undefined;
  let optionNumber: number | undefined;
  let dismiss = false;
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    switch (flag) {
      case AGENT_FLAG:
        if (agentName !== undefined) throw new Error(`mcq: ${AGENT_FLAG} was given twice`);
        agentName = readFlagValue(args, index, flag);
        index += 1;
        break;
      case ANSWER_FLAG:
        if (optionNumber !== undefined) throw new Error(`mcq: ${ANSWER_FLAG} was given twice`);
        optionNumber = parseOptionNumber(readFlagValue(args, index, flag));
        index += 1;
        break;
      case DISMISS_FLAG:
        dismiss = true;
        break;
      case DRY_RUN_FLAG:
        dryRun = true;
        break;
      default:
        throw new Error(`mcq: unknown argument "${flag}"`);
    }
  }
  if (agentName === undefined) throw new Error(`mcq: ${AGENT_FLAG} is required`);
  if ((optionNumber === undefined) === !dismiss) {
    throw new Error(`mcq: give exactly one of ${ANSWER_FLAG} <n> or ${DISMISS_FLAG}`);
  }
  return {
    agentName,
    action: dismiss ? { kind: 'dismiss' } : { kind: 'answer', optionNumber: optionNumber! },
    dryRun,
  };
}
