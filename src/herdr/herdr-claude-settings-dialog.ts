import { plainText, styledLinesFromAnsi } from "../codex-screen/composer/ansi.ts";
import type { SupportedComposerHarness } from "../codex-screen/composer/composer.types.ts";
import { HARNESS_NAMES } from "../harness-routing/harness.ts";
import { REGENT_NAME } from "../regent-state/regent-liveness.ts";
import { sameAgentName } from "./herdr-identity-contracts.ts";
import type { HerdrAgent } from "./herdr-inventory.service.ts";
import type { SupportedScreenReading } from "./herdr-screen.service.ts";
import type { SubmitToAgentDeps } from "./herdr-send.types.ts";

export const SETTINGS_DIALOG_ESCAPE_PRESS_LIMIT = 2;

const SETTINGS_DIALOG_TAB_LINE = /^ *Settings +Status +Config +Usage +Stats *$/u;
const SETTINGS_DIALOG_TOP_RULE = /^▔+ *$/u;

export function screenShowsClaudeSettingsDialog(
  visibleAnsi: string,
  composerIsUnavailable: boolean,
): boolean {
  if (!composerIsUnavailable) return false;
  const lines = styledLinesFromAnsi(visibleAnsi).map(plainText);
  return lines.some(
    (line, index) =>
      index > 0 &&
      SETTINGS_DIALOG_TAB_LINE.test(line) &&
      SETTINGS_DIALOG_TOP_RULE.test(lines[index - 1]!),
  );
}

export function regentPaneShowsSettingsDialog(
  agent: HerdrAgent,
  harness: SupportedComposerHarness,
  reading: SupportedScreenReading,
): boolean {
  return (
    harness === HARNESS_NAMES.CLAUDE &&
    sameAgentName(agent.name, REGENT_NAME) &&
    screenShowsClaudeSettingsDialog(
      reading.visibleAnsi,
      reading.snapshot.activeComposer.state === "unavailable",
    )
  );
}

export async function closeSettingsDialog(
  agent: HerdrAgent,
  deps: Pick<SubmitToAgentDeps, "pressPaneKey">,
  pressNumber: number,
): Promise<void> {
  await deps.pressPaneKey(agent.paneId, "Escape");
  process.stderr.write(
    `send-agent: pressed Escape to close the settings dialog on ${agent.name ?? agent.terminalId}'s pane ` +
      `(press ${pressNumber} of at most ${SETTINGS_DIALOG_ESCAPE_PRESS_LIMIT})\n`,
  );
}
