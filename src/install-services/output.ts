import type { UnitInstallOutcome } from '../install-services/service-unit-renderer.service.ts';

export function writeInstallServicesLine(line: string): void {
  process.stdout.write(`install-services: ${line}\n`);
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
