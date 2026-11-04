import { readdir } from "node:fs/promises";
import path from "node:path";
import { readSpawnSpec } from "../agentdata/spawn-data-contracts.ts";
import { REAPED_DIR_NAME } from "../agentdata/ledger-data.service.ts";
import {
  IdentityLineReadStatus,
  readAgentSupervisor,
} from "../agentdata/identity-data.service.ts";
import { sameAgentName } from "../herdr/herdr-identity-contracts.ts";
import { latestPlanBundle } from "../amendment/reconciliation-evidence.ts";

export type SingleSliceCheck = { ok: true } | { ok: false; detail: string };

export const SINGLE_SLICE_SEATS = {
  executor: "01",
  conformance: "99a",
  verify: "99b",
  delivery: "99c",
} as const;

type SingleSliceSeat = (typeof SINGLE_SLICE_SEATS)[keyof typeof SINGLE_SLICE_SEATS];

const SEAT_DESCRIPTIONS: Record<SingleSliceSeat, string> = {
  "01": "the 01 executor Shadow",
  "99a": "a separate 99a conformance Shadow",
  "99b": "a separate 99b verify Shadow",
  "99c": "a separate 99c delivery Shadow",
};

const REQUIRED_GATE_FILE_PREFIXES = [
  "99a_conform_",
  "99b_verify_",
  "99c_deliver_",
  "99d_record_",
] as const;

const IMPLEMENTATION_SLICE_FILE = /^(\d{2})_.+\.md$/;
const FIRST_IMPLEMENTATION_NUMBER = 1;
const LAST_IMPLEMENTATION_NUMBER = 97;
const EXECUTOR_SLICE_NUMBER = "01";
const SHADOW_SEAT_NAME = /^shadow-[a-z0-9]+-(01|99a|99b|99c)(?:-|$)/;

export const SINGLE_SLICE_RULE =
  "A single-slice campaign is exactly one implementation slice, 01_<task>.md, worked by one executor Shadow, " +
  "plus 99a_conform, 99b_verify, 99c_deliver and 99d_record, each gate run as its own Shadow distinct from the executor.";

export const SINGLE_SLICE_LORD_WORDS =
  'The Lord, 2026-11-04: "a single executor shadow, the 99 verification slices, and the alpha to act as the place ' +
  'where lord can still send messages to without interrupting the shadow" and "Best to codify it or alphas tend to ignore".';

export async function isSingleSliceAlpha(alphaName: string, dataDir: string): Promise<boolean> {
  return (await readSpawnSpec(alphaName, dataDir))?.single_slice === true;
}

function isImplementationSliceFile(fileName: string): boolean {
  const number = IMPLEMENTATION_SLICE_FILE.exec(fileName)?.[1];
  if (number === undefined) return false;
  const value = Number(number);
  return value >= FIRST_IMPLEMENTATION_NUMBER && value <= LAST_IMPLEMENTATION_NUMBER;
}

function missingGateFiles(fileNames: readonly string[]): string[] {
  return REQUIRED_GATE_FILE_PREFIXES.filter(
    (prefix) => !fileNames.some((fileName) => fileName.startsWith(prefix) && fileName.endsWith(".md")),
  ).map((prefix) => `${prefix}*.md`);
}

function implementationSliceProblem(slices: readonly string[], bundle: string): string | undefined {
  if (slices.length === 0) return `its plan folder ${bundle} holds no implementation slice`;
  if (slices.length > 1) {
    return `its plan folder ${bundle} holds ${slices.length} implementation slices (${slices.join(", ")})`;
  }
  return slices[0]!.startsWith(`${EXECUTOR_SLICE_NUMBER}_`)
    ? undefined
    : `its one implementation slice ${slices[0]} is not numbered ${EXECUTOR_SLICE_NUMBER}`;
}

export async function checkSingleSliceBundle(alphaName: string, dataDir: string): Promise<SingleSliceCheck> {
  const ledger = path.join(dataDir, alphaName);
  const bundle = await latestPlanBundle(ledger);
  if (bundle === undefined) return { ok: false, detail: "it has no todo-* plan folder yet" };
  const fileNames = await readdir(path.join(ledger, bundle)).catch(() => [] as string[]);
  const slices = fileNames.filter(isImplementationSliceFile).sort();
  const problems = [
    implementationSliceProblem(slices, bundle),
    ...missingGateFiles(fileNames).map((file) => `its plan folder ${bundle} has no ${file}`),
  ].filter((problem): problem is string => problem !== undefined);
  return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.join("; ") };
}

async function listLedgerNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function isSupervisedBy(shadowName: string, ledgerRoot: string, alphaName: string): Promise<boolean> {
  const supervisor = await readAgentSupervisor(shadowName, ledgerRoot);
  return supervisor.status === IdentityLineReadStatus.Found && sameAgentName(supervisor.value, alphaName);
}

function shadowSeat(shadowName: string): SingleSliceSeat | undefined {
  return SHADOW_SEAT_NAME.exec(shadowName)?.[1] as SingleSliceSeat | undefined;
}

async function seatsWithShadowLedgers(alphaName: string, dataDir: string): Promise<Set<SingleSliceSeat>> {
  const seats = new Set<SingleSliceSeat>();
  for (const ledgerRoot of [dataDir, path.join(dataDir, REAPED_DIR_NAME)]) {
    for (const name of await listLedgerNames(ledgerRoot)) {
      const seat = shadowSeat(name);
      if (seat !== undefined && (await isSupervisedBy(name, ledgerRoot, alphaName))) seats.add(seat);
    }
  }
  return seats;
}

export async function checkSingleSliceGateShadows(
  alphaName: string,
  dataDir: string,
  required: readonly SingleSliceSeat[],
): Promise<SingleSliceCheck> {
  const present = await seatsWithShadowLedgers(alphaName, dataDir);
  const missing = required.filter((seat) => !present.has(seat));
  if (missing.length === 0) return { ok: true };
  return {
    ok: false,
    detail: `no ledger, live or reaped, shows ${missing.map((seat) => SEAT_DESCRIPTIONS[seat]).join(", ")} under it`,
  };
}

const NOTHING_SPAWNED = "Nothing was registered or launched.";

function describeRefusal(subject: string, detail: string): string {
  return `${subject} — ${detail}. ${SINGLE_SLICE_RULE} ${SINGLE_SLICE_LORD_WORDS}`;
}

export async function singleSliceShadowSpawnRefusal(
  shadowName: string,
  alphaName: string,
  dataDir: string,
): Promise<string | undefined> {
  if (!(await isSingleSliceAlpha(alphaName, dataDir))) return undefined;
  const subject = `refusing Shadow "${shadowName}" under single-slice Alpha "${alphaName}"`;
  const bundle = await checkSingleSliceBundle(alphaName, dataDir);
  if (!bundle.ok) return `${describeRefusal(subject, bundle.detail)} ${NOTHING_SPAWNED}`;
  if (shadowSeat(shadowName) !== SINGLE_SLICE_SEATS.delivery) return undefined;
  const gates = await checkSingleSliceGateShadows(alphaName, dataDir, [
    SINGLE_SLICE_SEATS.executor,
    SINGLE_SLICE_SEATS.conformance,
    SINGLE_SLICE_SEATS.verify,
  ]);
  return gates.ok ? undefined : `${describeRefusal(subject, gates.detail)} ${NOTHING_SPAWNED}`;
}

export async function singleSliceCompletionRefusal(
  alphaName: string,
  dataDir: string,
): Promise<string | undefined> {
  if (!(await isSingleSliceAlpha(alphaName, dataDir))) return undefined;
  const gates = await checkSingleSliceGateShadows(alphaName, dataDir, Object.values(SINGLE_SLICE_SEATS));
  return gates.ok
    ? undefined
    : describeRefusal(`single-slice Alpha "${alphaName}" cannot complete`, gates.detail);
}
