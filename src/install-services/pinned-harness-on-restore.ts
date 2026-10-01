import { ensureHerdrResumeDisabled } from './herdr-session-config.ts';
import type {
  InstallServicesDeps,
  InstallServicesOptions,
} from './install-services.types.ts';
import { writeInstallServicesError, writeInstallServicesLine } from './output.ts';
import { rewriteTextFile, type TextFileRewriteOutcome } from './text-file-rewrite.ts';
import {
  throneSessionFilePath,
  throneSessionFileText,
  throneShellBlock,
  upsertThroneShellBlock,
} from './throne-shell-block.ts';

export type PinnedHarnessOnRestoreOutcome = 'installed' | 'error';

interface RewriteWording {
  subject: string;
  plannedChange: string;
  appliedChange: string;
}

function reportRewrite(
  outcome: TextFileRewriteOutcome,
  options: InstallServicesOptions,
  wording: RewriteWording,
  destination: string,
): void {
  if (outcome === 'unchanged') {
    writeInstallServicesLine(`${wording.subject}: unchanged → ${destination}`);
  } else if (options.dryRun) {
    writeInstallServicesLine(`would ${wording.plannedChange} → ${destination}`);
  } else {
    writeInstallServicesLine(`${wording.subject}: ${wording.appliedChange} → ${destination}`);
  }
}

async function turnOffHerdrResume(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<void> {
  const configPath = deps.herdrConfigPath();
  const outcome = await ensureHerdrResumeDisabled(configPath, options);
  reportRewrite(
    outcome,
    options,
    { subject: 'herdr agent resume', plannedChange: 'turn off herdr agent resume', appliedChange: 'turned off' },
    configPath,
  );
}

async function writeThroneSessionFile(options: InstallServicesOptions): Promise<void> {
  const sessionFile = throneSessionFilePath(options.throneRoot);
  const outcome = await rewriteTextFile(
    sessionFile,
    () => throneSessionFileText(options.throneRoot),
    options,
  );
  reportRewrite(
    outcome,
    options,
    { subject: 'throne session file', plannedChange: 'write throne session file', appliedChange: 'written' },
    sessionFile,
  );
}

async function addThroneShellBlockToBashrc(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<void> {
  const bashrc = deps.bashrcPath();
  const block = throneShellBlock(options.throneRoot);
  const outcome = await rewriteTextFile(
    bashrc,
    (rcText) => upsertThroneShellBlock(rcText, block),
    options,
  );
  reportRewrite(
    outcome,
    options,
    { subject: 'throne shell block', plannedChange: 'add throne shell block', appliedChange: 'added' },
    bashrc,
  );
}

async function runStep(
  description: string,
  step: () => Promise<void>,
): Promise<PinnedHarnessOnRestoreOutcome> {
  try {
    await step();
    return 'installed';
  } catch (error) {
    writeInstallServicesError(
      `install-services: ${description} failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 'error';
  }
}

export async function installPinnedHarnessOnRestore(
  deps: InstallServicesDeps,
  options: InstallServicesOptions,
): Promise<PinnedHarnessOnRestoreOutcome> {
  const outcomes = [
    await runStep('turning off herdr agent resume', () => turnOffHerdrResume(deps, options)),
    await runStep('writing the throne session file', () => writeThroneSessionFile(options)),
    await runStep('adding the throne shell block', () => addThroneShellBlockToBashrc(deps, options)),
  ];
  return outcomes.includes('error') ? 'error' : 'installed';
}
