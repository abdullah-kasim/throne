import { AsyncLocalStorage } from 'node:async_hooks';
import type { UnitInstallOutcome } from '../install-services/service-unit-renderer.service.ts';

export interface InstallServicesOutput {
  writeLine(line: string): void;
  writeError(text: string): void;
}

const redirectedOutput = new AsyncLocalStorage<InstallServicesOutput>();

export function withInstallServicesOutput<T>(
  output: InstallServicesOutput,
  work: () => Promise<T>,
): Promise<T> {
  return redirectedOutput.run(output, work);
}

export function writeInstallServicesLine(line: string): void {
  const output = redirectedOutput.getStore();
  if (output !== undefined) output.writeLine(line);
  else process.stdout.write(`install-services: ${line}\n`);
}

export function writeInstallServicesError(text: string): void {
  const output = redirectedOutput.getStore();
  if (output !== undefined) output.writeError(text);
  else process.stderr.write(text);
}

export function describeUnitInstallOutcome(
  outcome: UnitInstallOutcome,
): string {
  switch (outcome.action) {
    case 'unchanged':
      return `${outcome.basename}: unchanged`;
    case 'created':
      return `${outcome.basename}: installed → ${outcome.targetPath}`;
    case 'updated':
      return `${outcome.basename}: content changed → ${outcome.targetPath}`;
    case 'replaced-symlink':
      return `${outcome.basename}: replaced symlink → rendered file ${outcome.targetPath}`;
    case 'error':
      return `${outcome.basename}: ERROR ${outcome.message ?? 'unknown failure'}`;
  }
}
