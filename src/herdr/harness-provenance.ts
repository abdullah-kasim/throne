import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  HerdrForegroundProcess,
  HerdrPaneProcessInfo,
} from "./herdr-inventory.service.ts";
import { VENDORED_HARNESS_BINARY_DIRECTORY } from "./herdr-launch-command.ts";
import {
  argvExecutablePathCandidates,
  executableName,
  isHarnessExecutableName,
  isLiveHarnessProcess,
} from "./herdr-process-detection.ts";
import { getPaneProcessInfo } from "./herdr-runtime.service.ts";

export const HARNESS_PROVENANCE_STATES = {
  NO_HARNESS: "no-harness",
  PINNED: "pinned",
  FOREIGN: "foreign",
} as const;

export type HarnessProvenanceState =
  (typeof HARNESS_PROVENANCE_STATES)[keyof typeof HARNESS_PROVENANCE_STATES];

export interface HarnessProvenance {
  state: HarnessProvenanceState;
  executablePath: string | undefined;
  argv: readonly string[];
}

export interface HarnessProvenanceDeps {
  getPaneProcessInfo: (paneId: string) => Promise<HerdrPaneProcessInfo>;
  vendoredHarnessBinaryDirectory: string;
}

const REAL_HARNESS_PROVENANCE_DEPS: HarnessProvenanceDeps = {
  getPaneProcessInfo,
  vendoredHarnessBinaryDirectory: VENDORED_HARNESS_BINARY_DIRECTORY,
};

async function realPathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

async function resolvedVendoredHarnessBinaries(
  directory: string,
): Promise<Set<string>> {
  const entries = await readdir(directory).catch(() => []);
  const resolved = await Promise.all(
    entries.map((entry) => realPathOrUndefined(path.join(directory, entry))),
  );
  return new Set(resolved.filter((target) => target !== undefined));
}

function harnessExecutablePath(harnessProcess: HerdrForegroundProcess): string {
  return (
    argvExecutablePathCandidates(harnessProcess.argv).find((candidate) =>
      isHarnessExecutableName(executableName(candidate)),
    ) ?? harnessProcess.argv[0] ?? harnessProcess.name
  );
}

async function runsVendoredBinary(
  executablePath: string,
  vendoredBinaries: Set<string>,
): Promise<boolean> {
  if (!path.isAbsolute(executablePath)) return false;
  const resolved = await realPathOrUndefined(executablePath);
  return resolved !== undefined && vendoredBinaries.has(resolved);
}

export async function harnessProvenance(
  paneId: string,
  deps: HarnessProvenanceDeps = REAL_HARNESS_PROVENANCE_DEPS,
): Promise<HarnessProvenance> {
  const harnessProcesses = (
    await deps.getPaneProcessInfo(paneId)
  ).foregroundProcesses.filter(isLiveHarnessProcess);
  if (harnessProcesses.length === 0) {
    return {
      state: HARNESS_PROVENANCE_STATES.NO_HARNESS,
      executablePath: undefined,
      argv: [],
    };
  }
  const vendoredBinaries = await resolvedVendoredHarnessBinaries(
    deps.vendoredHarnessBinaryDirectory,
  );
  for (const harnessProcess of harnessProcesses) {
    const executablePath = harnessExecutablePath(harnessProcess);
    if (await runsVendoredBinary(executablePath, vendoredBinaries)) {
      return {
        state: HARNESS_PROVENANCE_STATES.PINNED,
        executablePath,
        argv: harnessProcess.argv,
      };
    }
  }
  const reported = harnessProcesses[0]!;
  return {
    state: HARNESS_PROVENANCE_STATES.FOREIGN,
    executablePath: harnessExecutablePath(reported),
    argv: reported.argv,
  };
}
