import { HARNESS_NAMES } from "../../harness-routing/harness.ts";
import { styledLinesFromAnsi } from "./ansi.ts";
import { readCodexPendingTexts, readCodexQueuedTexts } from "./codex-panels.ts";
import {
  activePromptMarker,
  claudeFrameHasInteractiveMenuHint,
  openCodeFrameHasBoxBottom,
  isOpenCodeMessageActionsModal,
  promptMarkerCandidates,
  readPromptRegion,
} from "./prompt-region.ts";
import { normalizeRenderedPayload } from "./rendered-text.ts";
import type {
  ComposerInspection,
  SupportedAgentScreenSnapshot,
  SupportedComposerHarness,
} from "./composer.types.ts";

export class ComposerService implements ComposerInspection {
  inspectSupportedAgentScreen(
    harness: SupportedComposerHarness,
    paneAnsi: string,
  ): SupportedAgentScreenSnapshot {
    const lines = styledLinesFromAnsi(paneAnsi);
    const candidates = promptMarkerCandidates(lines, harness);
    const selectedMarker = activePromptMarker(candidates, harness, lines);
    const selectedRegion =
      selectedMarker === undefined
        ? undefined
        : readPromptRegion(lines, selectedMarker, harness);
    const selectedIsActive = selectedRegion?.active === true;
    const promptTexts =
      harness === HARNESS_NAMES.OPENCODE
        ? []
        : candidates
            .filter(
              (candidate) =>
                !selectedIsActive ||
                candidate.lineIndex !== selectedMarker!.lineIndex ||
                candidate.characterIndex !== selectedMarker!.characterIndex,
            )
            .map(
              (candidate) => readPromptRegion(lines, candidate, harness).text,
            )
            .filter((text) => text.length > 0);

    let activeComposer: SupportedAgentScreenSnapshot["activeComposer"];
    if (!selectedIsActive) {
      activeComposer = { state: "unavailable" };
    } else if (harness === HARNESS_NAMES.OPENCODE) {
      const hasBoxBottom = openCodeFrameHasBoxBottom(lines);
      if (selectedRegion!.text.length === 0) {
        activeComposer = hasBoxBottom
          ? { state: "empty", text: "" }
          : { state: "unavailable" };
      } else {
        activeComposer = hasBoxBottom
          ? { state: "draft", text: selectedRegion!.text }
          : { state: "modal" };
      }
    } else if (selectedRegion!.text.length === 0) {
      activeComposer = { state: "empty", text: "" };
    } else if (
      harness === HARNESS_NAMES.CLAUDE &&
      claudeFrameHasInteractiveMenuHint(lines)
    ) {
      activeComposer = { state: "modal" };
    } else {
      activeComposer = { state: "draft", text: selectedRegion!.text };
    }

    return {
      activeComposer,
      ...(harness === HARNESS_NAMES.OPENCODE &&
      isOpenCodeMessageActionsModal(lines)
        ? { messageActionsModal: true }
        : {}),
      promptTexts,
      codexQueuedTexts:
        harness === HARNESS_NAMES.CODEX ? readCodexQueuedTexts(lines) : [],
      codexPendingTexts:
        harness === HARNESS_NAMES.CODEX ? readCodexPendingTexts(lines) : [],
    };
  }

  isSupportedComposerEmpty(
    harness: SupportedComposerHarness,
    paneAnsi: string,
  ): boolean {
    return (
      this.inspectSupportedAgentScreen(harness, paneAnsi).activeComposer
        .state === "empty"
    );
  }

  activeBottomComposerHasDraft(harness: string, paneAnsi: string): boolean {
    if (
      harness !== HARNESS_NAMES.CLAUDE &&
      harness !== HARNESS_NAMES.CODEX &&
      harness !== HARNESS_NAMES.OPENCODE &&
      harness !== HARNESS_NAMES.OMP
    )
      return false;
    return (
      this.inspectSupportedAgentScreen(harness, paneAnsi).activeComposer
        .state === "draft"
    );
  }

  normalizeRenderedPayload(text: string): string {
    return normalizeRenderedPayload(text);
  }
}

const DEFAULT_COMPOSER_SERVICE = new ComposerService();
export const inspectSupportedAgentScreen =
  DEFAULT_COMPOSER_SERVICE.inspectSupportedAgentScreen.bind(
    DEFAULT_COMPOSER_SERVICE,
  );
export const isSupportedComposerEmpty =
  DEFAULT_COMPOSER_SERVICE.isSupportedComposerEmpty.bind(
    DEFAULT_COMPOSER_SERVICE,
  );
export const activeBottomComposerHasDraft =
  DEFAULT_COMPOSER_SERVICE.activeBottomComposerHasDraft.bind(
    DEFAULT_COMPOSER_SERVICE,
  );
