import type { SpawnSpec } from '../../agentdata/spawn-data-contracts.ts';
import { errorText } from '../../shared-policy/error-text.ts';
import type { PhaseLog } from './phase-log.ts';
import {
  type SpawnEvidenceVerdict,
  type SwitchTransactionDeps,
  type SwitchTransactionInput,
} from './transaction.types.ts';

export async function checkPreservedBytes(
  input: SwitchTransactionInput,
  deps: SwitchTransactionDeps,
  log: PhaseLog,
): Promise<boolean> {
  let current;
  try {
    current = await deps.readPreservedBytes();
  } catch (error) {
    log.failed('verify-preserved-bytes', errorText(error));
    return false;
  }
  const unchanged =
    current.identity === input.preserved.identity &&
    current.tree === input.preserved.tree;
  if (unchanged) {
    log.ok('verify-preserved-bytes');
  } else {
    log.failed('verify-preserved-bytes', 'identity or tree bytes changed during the switch');
  }
  return unchanged;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameSpawnSpec(left: SpawnSpec, right: SpawnSpec): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export async function readBackSpawnEvidence(
  deps: SwitchTransactionDeps,
  intended: SpawnSpec,
  original: SpawnSpec,
  log: PhaseLog,
): Promise<SpawnEvidenceVerdict> {
  const read = deps.readSpawnSpec;
  if (read === undefined) {
    log.failed('read-back-spawn', 'no spawn readback is available');
    return 'unknown';
  }
  let stored: SpawnSpec;
  try {
    stored = await read();
  } catch (error) {
    log.failed('read-back-spawn', errorText(error));
    return 'unknown';
  }
  if (sameSpawnSpec(stored, intended)) {
    log.ok('read-back-spawn', 'applied');
    return true;
  }
  if (sameSpawnSpec(stored, original)) {
    log.ok('read-back-spawn', 'unapplied');
    return false;
  }
  log.failed('read-back-spawn', 'stored spawn evidence matches neither the intended nor the original record');
  return 'unknown';
}
