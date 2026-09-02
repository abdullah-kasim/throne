import type { Harness } from "../../harness-routing/harness.ts";

export type SupportedComposerHarness = Harness;

export type ActiveComposerSnapshot =
  | { state: "unavailable" }
  | { state: "empty"; text: "" }
  | { state: "draft"; text: string }
  | { state: "modal" };

export interface SupportedAgentScreenSnapshot {
  activeComposer: ActiveComposerSnapshot;
  messageActionsModal?: boolean;
  promptTexts: string[];
  codexQueuedTexts: string[];
  codexPendingTexts: string[];
}

export interface ComposerInspection {
  inspectSupportedAgentScreen(
    harness: SupportedComposerHarness,
    paneAnsi: string,
  ): SupportedAgentScreenSnapshot;
  isSupportedComposerEmpty(
    harness: SupportedComposerHarness,
    paneAnsi: string,
  ): boolean;
  activeBottomComposerHasDraft(harness: string, paneAnsi: string): boolean;
  normalizeRenderedPayload(text: string): string;
}
