import { parseTestItemDurationsMs } from "./suite-duration-gate.mjs";

export const RUN_STARTED_AT_ENVIRONMENT_VARIABLE = "THRONE_SUITE_RUN_STARTED_AT_MS";
export const SLOWEST_TEST_COUNT = 20;
export const TMPFS_SLOT_GUARD_WAIT = "tmpfs slot guard";

export const SuitePhase = Object.freeze({
  SLOT_WAIT: "slot wait",
  IMAGE_BUILD: "image build",
  GUARDS_DURING_IMAGE_BUILD: "guards during image build",
  CONTAINER_START: "container start",
  LINT: "lint",
  GUARDS: "guards",
  TESTS: "tests",
  POST_GUARDS: "post-guards",
});

const PHASE_START_MARK_PREFIX = "suite-phase-start: ";

const PHASE_FIRST_LINES = [
  { phase: SuitePhase.LINT, firstLine: /^> \S+ lint:private-refs$/ },
  { phase: SuitePhase.GUARDS, firstLine: new RegExp(`^${PHASE_START_MARK_PREFIX}${SuitePhase.GUARDS}$`) },
  { phase: SuitePhase.TESTS, firstLine: new RegExp(`^${PHASE_START_MARK_PREFIX}${SuitePhase.TESTS}$`) },
  { phase: SuitePhase.POST_GUARDS, firstLine: new RegExp(`^${PHASE_START_MARK_PREFIX}${SuitePhase.POST_GUARDS}$`) },
];

export function formatPhaseStartMark(phase) {
  return `${PHASE_START_MARK_PREFIX}${phase}\n`;
}

export function readRunStartedAtMs(environment, fallbackMs) {
  const startedAtMs = Number(environment[RUN_STARTED_AT_ENVIRONMENT_VARIABLE]);
  return Number.isFinite(startedAtMs) && startedAtMs > 0 ? startedAtMs : fallbackMs;
}

export function createOutputLineRecorder(now = Date.now) {
  const lines = [];
  let unfinishedLine = "";
  return {
    record(chunk) {
      const arrivedAtMs = now();
      const pieces = (unfinishedLine + chunk).split("\n");
      unfinishedLine = pieces.pop();
      for (const text of pieces) lines.push({ text, arrivedAtMs });
    },
    lines() {
      return unfinishedLine === "" ? lines : [...lines, { text: unfinishedLine, arrivedAtMs: now() }];
    },
  };
}

export function findPhaseStarts(lines) {
  return PHASE_FIRST_LINES.map(({ phase, firstLine }) => ({
    phase,
    startedAtMs: lines.find((line) => firstLine.test(line.text))?.arrivedAtMs,
  }));
}

export function measurePhases(phaseStarts, endedAtMs) {
  return phaseStarts.map(({ phase, startedAtMs }, index) => {
    if (startedAtMs === undefined) return { phase, reached: false };
    const nextStart = phaseStarts.slice(index + 1).find((later) => later.startedAtMs !== undefined);
    return { phase, reached: true, startedAtMs, elapsedMs: (nextStart?.startedAtMs ?? endedAtMs) - startedAtMs };
  });
}

export function listSlowestTestItems(items, count = SLOWEST_TEST_COUNT) {
  const distinctItems = new Map(items.map((item) => [`${item.durationMs} ${item.name}`, item]));
  return [...distinctItems.values()].sort((first, second) => second.durationMs - first.durationMs).slice(0, count);
}

function formatPhaseLine(measured, runStartedAtMs) {
  if (!measured.reached) return `suite-phase: ${measured.phase} not reached\n`;
  return `suite-phase: ${measured.phase} from_run_start_ms=${measured.startedAtMs - runStartedAtMs} elapsed_ms=${measured.elapsedMs}\n`;
}

function formatSlowestTestsBlock(slowestItems) {
  return [
    `suite-slowest-tests: the ${slowestItems.length} slowest timed items (leaf tests and suites alike)\n`,
    ...slowestItems.map((item, index) => `  ${index + 1}. ${item.durationMs}ms ${item.name}\n`),
  ].join("");
}

export function formatSuiteTimingReport({
  runStartedAtMs,
  slotHeldAtMs,
  imageBuild,
  hostGuards,
  outputLines,
  containerExitedAtMs,
  suiteOutput,
}) {
  const insideContainer = measurePhases(findPhaseStarts(outputLines), containerExitedAtMs);
  const firstInsideStart = insideContainer.find((measured) => measured.reached)?.startedAtMs ?? containerExitedAtMs;
  const measuredPhases = [
    { phase: SuitePhase.SLOT_WAIT, reached: true, startedAtMs: runStartedAtMs, elapsedMs: slotHeldAtMs - runStartedAtMs },
    { phase: SuitePhase.IMAGE_BUILD, reached: true, startedAtMs: imageBuild.startedAtMs, elapsedMs: imageBuild.finishedAtMs - imageBuild.startedAtMs },
    { phase: SuitePhase.GUARDS_DURING_IMAGE_BUILD, reached: true, startedAtMs: hostGuards.startedAtMs, elapsedMs: hostGuards.finishedAtMs - hostGuards.startedAtMs },
    { phase: SuitePhase.CONTAINER_START, reached: true, startedAtMs: imageBuild.finishedAtMs, elapsedMs: firstInsideStart - imageBuild.finishedAtMs },
    ...insideContainer,
  ];
  return [
    ...measuredPhases.map((measured) => formatPhaseLine(measured, runStartedAtMs)),
    `suite-lock-wait: ${TMPFS_SLOT_GUARD_WAIT} elapsed_ms=${slotHeldAtMs - runStartedAtMs}\n`,
    formatSlowestTestsBlock(listSlowestTestItems(parseTestItemDurationsMs(suiteOutput))),
  ].join("");
}
