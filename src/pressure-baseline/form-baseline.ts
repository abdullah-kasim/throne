import {
  baselineFileIn,
  baselineFromRounds,
  currentMachine,
  writeBaseline,
  type PressureBaseline,
  type TakenRound,
} from "./pressure-baseline-store.ts";
import { probeResponsiveness } from "./responsiveness-probes.ts";
import { formatMilliseconds } from "./responsiveness-report.ts";
import { readMachineQuiet, type QuietReading } from "./machine-quiet.ts";

export const BASELINE_ROUNDS = 20;
export const BASELINE_ROUND_SPACING_MILLISECONDS = 1500;
export const FORM_UNDER_LOAD_PROMPT = "Form the baseline at the current load anyway? [y/N] ";

const YES_ANSWERS: ReadonlySet<string> = new Set(["y", "yes"]);

export const FormBaselineExitCode = {
  Formed: 0,
  NotFormed: 1,
} as const;

export type FormBaselineExitCode = (typeof FormBaselineExitCode)[keyof typeof FormBaselineExitCode];

export interface BaselineFormingContext {
  readonly dataHome: string;
  readonly userHome: string;
  readonly inputIsTerminal: boolean;
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly print: (line: string) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly readQuiet?: () => QuietReading;
  readonly now?: () => Date;
}

export function answeredYes(answer: string | undefined): boolean {
  return YES_ANSWERS.has((answer ?? "").trim().toLowerCase());
}

async function mayFormUnderLoad(context: BaselineFormingContext, reason: string): Promise<boolean> {
  context.print(reason);
  if (!context.inputIsTerminal) return false;
  return answeredYes(await context.ask(FORM_UNDER_LOAD_PROMPT));
}

function currentTime(context: BaselineFormingContext): Date {
  return context.now?.() ?? new Date();
}

async function takeBaselineRounds(context: BaselineFormingContext): Promise<TakenRound[]> {
  const rounds: TakenRound[] = [];
  for (let round = 1; round <= BASELINE_ROUNDS; round += 1) {
    if (round > 1) await context.sleep(BASELINE_ROUND_SPACING_MILLISECONDS);
    const at = currentTime(context);
    rounds.push({ ...(await probeResponsiveness(context.dataHome, context.userHome)), at });
  }
  return rounds;
}

function printFormedBaseline(context: BaselineFormingContext, baseline: PressureBaseline): void {
  const medianText = (medianMs: number | null) => (medianMs === null ? "none" : formatMilliseconds(medianMs));
  context.print(
    `baseline formed: git median ${medianText(baseline.probes.git.medianMs)} · disk median ${medianText(baseline.probes.disk.medianMs)}`,
  );
  context.print(`baseline file: ${baselineFileIn(context.dataHome)}`);
}

export async function formBaseline(context: BaselineFormingContext): Promise<FormBaselineExitCode> {
  const quiet = (context.readQuiet ?? readMachineQuiet)();
  const formedUnderLoadReason = quiet.quiet ? undefined : quiet.reason;
  if (formedUnderLoadReason !== undefined && !(await mayFormUnderLoad(context, formedUnderLoadReason))) {
    return FormBaselineExitCode.NotFormed;
  }
  const rounds = await takeBaselineRounds(context);
  const baseline = baselineFromRounds(await currentMachine(context.userHome), rounds, formedUnderLoadReason);
  printFormedBaseline(context, await writeBaseline(context.dataHome, baseline, currentTime(context)));
  return FormBaselineExitCode.Formed;
}
