import {
  ComposerService,
} from "./composer/composer.service.ts";
import type { SupportedAgentScreenSnapshot } from "./composer/composer.types.ts";
import { HARNESS_NAMES, isCodexNpmWrapperProcess } from "../harness-routing/harness.ts";

export const CODEX_SCREEN_ADAPTER_VERSION = 1 as const;
export interface CodexPaneEvidence {
  paneId: string;
  foregroundProcesses: { name: string; argv: string[] }[];
}
export interface CodexScreenEvidence {
  expectedPaneId: string;
  processInfo: CodexPaneEvidence;
  visibleAnsi: string;
  recentAnsi?: string;
}
export type CodexScreenDiagnosticCode =
  | "pane-authority-changed"
  | "external-interactive-process"
  | "expected-harness-missing"
  | "active-composer-unrecognized";
export interface CodexScreenDiagnostic {
  adapterVersion: typeof CODEX_SCREEN_ADAPTER_VERSION;
  code: CodexScreenDiagnosticCode;
  surface: "pane" | "processes" | "visible-composer";
  detail: string;
}
export type CodexScreenObservation =
  | {
      kind: "observed";
      adapterVersion: typeof CODEX_SCREEN_ADAPTER_VERSION;
      snapshot: SupportedAgentScreenSnapshot;
    }
  | {
      kind: "unknown-layout";
      adapterVersion: typeof CODEX_SCREEN_ADAPTER_VERSION;
      diagnostic: CodexScreenDiagnostic;
    };

const INTERPRETERS = new Set([
  "bash",
  "bun",
  "env",
  "fish",
  "node",
  "python",
  "python3",
  "sh",
  "zsh",
]);
const EDITORS = new Set([
  "emacs",
  "emacsclient",
  "helix",
  "hx",
  "less",
  "man",
  "micro",
  "more",
  "nano",
  "nvim",
  "vi",
  "vim",
]);
const ACTIVE_TURN = /^•(?:\s+Working(?:\s.*)?)?$/u;
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const executable = (value: string): string =>
  value.replaceAll("\\", "/").split("/").pop() ?? "";
function candidates(process: { name: string; argv: string[] }): string[] {
  const argv = executable(process.argv[0] ?? "");
  return [
    executable(process.name),
    argv,
    ...(INTERPRETERS.has(argv)
      ? process.argv
          .slice(1, 5)
          .filter((arg) => !arg.startsWith("-") && !arg.includes("="))
          .map(executable)
      : []),
  ];
}
function diagnostic(
  code: CodexScreenDiagnosticCode,
  surface: CodexScreenDiagnostic["surface"],
  detail: string,
): CodexScreenObservation {
  return {
    kind: "unknown-layout",
    adapterVersion: CODEX_SCREEN_ADAPTER_VERSION,
    diagnostic: {
      adapterVersion: CODEX_SCREEN_ADAPTER_VERSION,
      code,
      surface,
      detail,
    },
  };
}
export function codexScreenShowsActiveTurn(visibleAnsi: string): boolean {
  return visibleAnsi
    .split(/\r?\n/u)
    .some((line) => ACTIVE_TURN.test(line.replace(ANSI, "").trim()));
}
export function observeCodexScreenV1(
  evidence: CodexScreenEvidence,
  composer: Pick<
    ComposerService,
    "inspectSupportedAgentScreen"
  > = new ComposerService(),
): CodexScreenObservation {
  if (evidence.processInfo.paneId !== evidence.expectedPaneId)
    return diagnostic(
      "pane-authority-changed",
      "pane",
      `expected pane "${evidence.expectedPaneId}", observed "${evidence.processInfo.paneId}"`,
    );
  const names = evidence.processInfo.foregroundProcesses.flatMap(candidates);
  const editor = names.find((name) => EDITORS.has(name));
  if (editor !== undefined)
    return diagnostic(
      "external-interactive-process",
      "processes",
      `pane "${evidence.expectedPaneId}" has an external editor/modal controlled by external process "${editor}"`,
    );
  const hasCodex = evidence.processInfo.foregroundProcesses.some((process) => {
    const name = executable(process.name);
    const argv = executable(process.argv[0] ?? "");
    return (
      name === "codex" ||
      name === "codexy" ||
      name === "codexy-all-omni" ||
      (argv === "node" && executable(process.argv[1] ?? "") === "codex") ||
      isCodexNpmWrapperProcess(process)
    );
  });
  if (!hasCodex)
    return diagnostic(
      "expected-harness-missing",
      "processes",
      `pane "${evidence.expectedPaneId}" has no recognized Codex process; observed [${names.join(", ") || "none"}]`,
    );
  const visible = composer.inspectSupportedAgentScreen(
    HARNESS_NAMES.CODEX,
    evidence.visibleAnsi,
  );
  if (visible.activeComposer.state === "unavailable")
    return diagnostic(
      "active-composer-unrecognized",
      "visible-composer",
      "no attributable structural transition: no supported active bottom Codex composer was found",
    );
  const promptTexts =
    evidence.recentAnsi === undefined
      ? visible.promptTexts
      : composer.inspectSupportedAgentScreen(
          HARNESS_NAMES.CODEX,
          evidence.recentAnsi,
        ).promptTexts;
  return {
    kind: "observed",
    adapterVersion: CODEX_SCREEN_ADAPTER_VERSION,
    snapshot: { ...visible, promptTexts },
  };
}

/** Nest-owned boundary for Codex pane evidence interpretation. */
export class CodexScreenService {
  private readonly composer: ComposerService;

  constructor(composer: ComposerService) {
    this.composer = composer;
  }

  readonly codexScreenShowsActiveTurn = codexScreenShowsActiveTurn;
  observeCodexScreenV1(evidence: CodexScreenEvidence): CodexScreenObservation {
    return observeCodexScreenV1(evidence, this.composer);
  }
}
