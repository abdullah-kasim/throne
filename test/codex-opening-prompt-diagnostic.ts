import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  inspectSupportedAgentScreen,
  type ActiveComposerSnapshot,
  type SupportedAgentScreenSnapshot,
} from "../src/codex-screen/composer/composer.service.ts";
import { normalizeRenderedPayload } from "../src/codex-screen/composer/rendered-text.ts";
import {
  readVisibleAgentAnsi,
  type HerdrAgent,
} from "../src/herdr/herdr-screen.service.ts";
import { resolveAgent } from "../src/herdr/herdr-runtime.service.ts";
import type { HerdrAgent } from "../src/herdr/herdr-inventory.service.ts";
import { HARNESS_NAMES } from "../src/harness-routing/harness.ts";
import { RecipientPaneLockService } from "../src/shared-policy/recipient-pane-lock.service.ts";

const withRecipientPaneLock =
  new RecipientPaneLockService().withRecipientPaneLock.bind(
    new RecipientPaneLockService(),
  );

const RETAINED_REGISTRATION_PATTERN =
  /registration in data\/[^/]+\/ are retained/iu;
const DELIVERY_BEGAN_PATTERN =
  /Delivery had already begun, so it was NOT resent/iu;
const OPERATING_SYSTEM_COMMAND_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/gu;
const DEFAULT_CAPTURE_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_POLL_MS = 100;

interface DifferenceSide {
  codePointStart: number;
  codePointEndExclusive: number;
  utf8ByteStart: number;
  utf8ByteEndExclusive: number;
  text: string;
  codePoints: Array<{
    index: number;
    utf8ByteStart: number;
    value: string;
    unicode: string;
  }>;
}

interface DifferenceWindow {
  equal: boolean;
  commonPrefixCodePoints: number;
  commonSuffixCodePoints: number;
  expected: DifferenceSide;
  observed: DifferenceSide;
}

interface NormalizationStage {
  name: "raw" | "parser-rendered-whitespace";
  expected: string;
  observed: string;
  difference: DifferenceWindow;
}

export interface CodexOpeningPromptDiagnosticArtifact {
  schemaVersion: 1;
  capturedAt: string;
  agent: {
    name: string;
    paneId: string;
    terminalId: string;
    cwd: string;
    harness: string;
  };
  expectedOpeningPayload: string;
  parsedActiveComposerText: string;
  parserReplay: {
    visibleAnsiFile: string;
    visibleAnsiSha256: string;
    parsed: SupportedAgentScreenSnapshot;
  };
  normalizationStages: NormalizationStage[];
}

export interface CaptureCodexOpeningPromptDiagnosticInput {
  name: string;
  ledgerPath: string;
  stderr: string;
  expectedOpeningPayload: string;
  captureTimeoutMs?: number;
  capturePollMs?: number;
}

export interface CaptureCodexOpeningPromptDiagnosticDeps {
  resolveAgent(name: string): Promise<HerdrAgent>;
  readVisibleAgentAnsi(paneId: string): Promise<string>;
  withRecipientPaneLock<T>(
    paneId: string,
    action: () => Promise<T>,
  ): Promise<T>;
  mkdir(directory: string): Promise<void>;
  writeFile(filePath: string, contents: string): Promise<void>;
  readFile(filePath: string): Promise<string>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

const REAL_CAPTURE_DEPS: CaptureCodexOpeningPromptDiagnosticDeps = {
  resolveAgent,
  readVisibleAgentAnsi,
  withRecipientPaneLock: (paneId, action) =>
    withRecipientPaneLock(paneId, action),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true });
  },
  writeFile: async (filePath, contents) => {
    await writeFile(filePath, contents, "utf8");
  },
  readFile: (filePath) => readFile(filePath, "utf8"),
  sleep: async (milliseconds) => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  },
  now: Date.now,
};

function sameActiveComposer(
  left: ActiveComposerSnapshot,
  right: ActiveComposerSnapshot,
): boolean {
  return (
    left.state === right.state &&
    (left.state !== "draft" ||
      (right.state === "draft" && left.text === right.text))
  );
}

function minimumParserReplay(
  visibleAnsi: string,
  parsed: SupportedAgentScreenSnapshot,
): { ansi: string; parsed: SupportedAgentScreenSnapshot } {
  const sanitized = visibleAnsi.replace(OPERATING_SYSTEM_COMMAND_PATTERN, "");
  const lines = sanitized.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    const candidate = lines.slice(start).join("\n");
    const replay = inspectSupportedAgentScreen(HARNESS_NAMES.CODEX, candidate);
    if (
      sameActiveComposer(replay.activeComposer, parsed.activeComposer) &&
      replay.promptTexts.length === 0 &&
      replay.codexQueuedTexts.length === 0 &&
      replay.codexPendingTexts.length === 0
    ) {
      return { ansi: candidate, parsed: replay };
    }
  }
  throw new Error(
    "the visible Codex observation could not be reduced to an isolated parser replay",
  );
}

function codePointSide(
  codePoints: string[],
  start: number,
  endExclusive: number,
): DifferenceSide {
  const prefix = codePoints.slice(0, start).join("");
  const selected = codePoints.slice(start, endExclusive);
  let byteOffset = Buffer.byteLength(prefix, "utf8");
  const rows = selected.map((value, offset) => {
    const row = {
      index: start + offset,
      utf8ByteStart: byteOffset,
      value,
      unicode: `U+${value.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    };
    byteOffset += Buffer.byteLength(value, "utf8");
    return row;
  });
  return {
    codePointStart: start,
    codePointEndExclusive: endExclusive,
    utf8ByteStart: Buffer.byteLength(prefix, "utf8"),
    utf8ByteEndExclusive: byteOffset,
    text: selected.join(""),
    codePoints: rows,
  };
}

function differenceWindow(
  expected: string,
  observed: string,
): DifferenceWindow {
  const expectedCodePoints = Array.from(expected);
  const observedCodePoints = Array.from(observed);
  let prefix = 0;
  while (
    prefix < expectedCodePoints.length &&
    prefix < observedCodePoints.length &&
    expectedCodePoints[prefix] === observedCodePoints[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < expectedCodePoints.length - prefix &&
    suffix < observedCodePoints.length - prefix &&
    expectedCodePoints[expectedCodePoints.length - suffix - 1] ===
      observedCodePoints[observedCodePoints.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    equal: expected === observed,
    commonPrefixCodePoints: prefix,
    commonSuffixCodePoints: suffix,
    expected: codePointSide(
      expectedCodePoints,
      prefix,
      expectedCodePoints.length - suffix,
    ),
    observed: codePointSide(
      observedCodePoints,
      prefix,
      observedCodePoints.length - suffix,
    ),
  };
}

function normalizationStages(
  expected: string,
  observed: string,
): NormalizationStage[] {
  const stages: Array<Omit<NormalizationStage, "difference">> = [
    { name: "raw", expected, observed },
    {
      name: "parser-rendered-whitespace",
      expected: normalizeRenderedPayload(expected),
      observed: normalizeRenderedPayload(observed),
    },
  ];
  return stages.map((stage) => ({
    ...stage,
    difference: differenceWindow(stage.expected, stage.observed),
  }));
}

function requireSameAgent(expected: HerdrAgent, observed: HerdrAgent): void {
  if (
    expected.name === undefined ||
    observed.name === undefined ||
    expected.name.toLowerCase() !== observed.name.toLowerCase() ||
    expected.paneId !== observed.paneId ||
    expected.terminalId !== observed.terminalId ||
    expected.agent !== observed.agent ||
    expected.cwd !== observed.cwd
  ) {
    throw new Error(
      "the diagnostic agent changed identity while waiting for its pane lock",
    );
  }
  if (observed.agent !== HARNESS_NAMES.CODEX) {
    throw new Error(
      `the diagnostic agent uses ${observed.agent}, not native Codex`,
    );
  }
}

async function readDraftObservation(
  agent: HerdrAgent,
  timeoutMs: number,
  pollMs: number,
  deps: CaptureCodexOpeningPromptDiagnosticDeps,
): Promise<{ visibleAnsi: string; parsed: SupportedAgentScreenSnapshot }> {
  const deadline = deps.now() + timeoutMs;
  while (true) {
    const visibleAnsi = await deps.readVisibleAgentAnsi(agent.paneId);
    const parsed = inspectSupportedAgentScreen(
      HARNESS_NAMES.CODEX,
      visibleAnsi,
    );
    if (parsed.activeComposer.state === "draft") return { visibleAnsi, parsed };
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      throw new Error(
        `the retained Codex pane never exposed a draft composer; final state=${parsed.activeComposer.state}`,
      );
    }
    await deps.sleep(Math.min(pollMs, remaining));
  }
}

export function openingPayloadFromIdentityDocument(
  name: string,
  identityDocument: string,
): string {
  const marker = `\n\nYou are \`${name}\` (`;
  const start = identityDocument.indexOf(marker);
  if (
    start === -1 ||
    identityDocument.indexOf(marker, start + marker.length) !== -1
  ) {
    throw new Error(
      `identity.md for ${name} does not contain one exact opening payload boundary`,
    );
  }
  const payloadWithTrailingNewline = identityDocument.slice(start + 2);
  if (!payloadWithTrailingNewline.endsWith("\n")) {
    throw new Error(`identity.md for ${name} has no final record newline`);
  }
  return payloadWithTrailingNewline.slice(0, -1);
}

export async function captureRetainedCodexOpeningPromptFailure(
  input: CaptureCodexOpeningPromptDiagnosticInput,
  deps: CaptureCodexOpeningPromptDiagnosticDeps = REAL_CAPTURE_DEPS,
): Promise<{
  directory: string;
  artifact: CodexOpeningPromptDiagnosticArtifact;
}> {
  if (!RETAINED_REGISTRATION_PATTERN.test(input.stderr)) {
    throw new Error(
      "native Codex create failure did not retain its registration",
    );
  }
  if (!DELIVERY_BEGAN_PATTERN.test(input.stderr)) {
    throw new Error(
      "native Codex create failure did not report that delivery had already begun",
    );
  }
  const initial = await deps.resolveAgent(input.name);
  return deps.withRecipientPaneLock(initial.paneId, async () => {
    const locked = await deps.resolveAgent(input.name);
    requireSameAgent(initial, locked);
    const observation = await readDraftObservation(
      locked,
      input.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
      input.capturePollMs ?? DEFAULT_CAPTURE_POLL_MS,
      deps,
    );
    const replay = minimumParserReplay(
      observation.visibleAnsi,
      observation.parsed,
    );
    if (replay.parsed.activeComposer.state !== "draft") {
      throw new Error(
        "the isolated parser replay lost the retained Codex draft",
      );
    }
    const directory = path.join(
      input.ledgerPath,
      "evidence",
      "native-codex-opening-prompt-failure",
    );
    const visibleAnsiFile = "visible-composer.ansi";
    const visibleAnsiPath = path.join(directory, visibleAnsiFile);
    const artifactPath = path.join(directory, "diagnostic.json");
    const artifact: CodexOpeningPromptDiagnosticArtifact = {
      schemaVersion: 1,
      capturedAt: new Date(deps.now()).toISOString(),
      agent: {
        name: input.name,
        paneId: locked.paneId,
        terminalId: locked.terminalId,
        cwd: locked.cwd,
        harness: locked.agent,
      },
      expectedOpeningPayload: input.expectedOpeningPayload,
      parsedActiveComposerText: replay.parsed.activeComposer.text,
      parserReplay: {
        visibleAnsiFile,
        visibleAnsiSha256: createHash("sha256")
          .update(replay.ansi, "utf8")
          .digest("hex"),
        parsed: replay.parsed,
      },
      normalizationStages: normalizationStages(
        input.expectedOpeningPayload,
        replay.parsed.activeComposer.text,
      ),
    };
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    await deps.mkdir(directory);
    await deps.writeFile(visibleAnsiPath, replay.ansi);
    await deps.writeFile(artifactPath, serialized);
    if ((await deps.readFile(visibleAnsiPath)) !== replay.ansi) {
      throw new Error(
        "the sanitized visible Codex observation failed readback",
      );
    }
    if ((await deps.readFile(artifactPath)) !== serialized) {
      throw new Error("the Codex opening-prompt diagnostic failed readback");
    }
    return { directory, artifact };
  });
}

export interface DiagnosticCleanupAction {
  name: string;
  run(): Promise<void>;
}

export async function cleanupCodexOpeningPromptDiagnostic(
  actions: readonly DiagnosticCleanupAction[],
): Promise<void> {
  const failures: unknown[] = [];
  const failedNames: string[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      failedNames.push(action.name);
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `native Codex opening-prompt diagnostic cleanup failed: ${failedNames.join(", ")}`,
    );
  }
}
