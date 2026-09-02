// The tristate-supervisor-read decision rules `idle-family.ts` builds its
// orphan/child-attribution logic on -- kept as its own companion module so
// that read-layer decision stays in one place instead of growing inline
// wherever `IdleFamilyEvidence.supervisors` happens to get read.
import {
  IdentityLineReadStatus,
  type IdentityLineRead,
} from '../agentdata/identity-data.service.ts';

const VALID_IDENTITY_LINE_READ_STATUSES: readonly string[] = Object.values(
  IdentityLineReadStatus,
);

/**
 * Runtime guard at the boundary where `IdleFamilyEvidence.supervisors`
 * values are actually consumed. TypeScript only protects `.ts` callers --
 * this campaign already shipped five raw-string-supervisor instances
 * (slices 05, 06, 07, 10) from non-TS-checked construction paths (a `.mjs`
 * driver among them), each one bypassing the compiler by construction. A
 * plain string or any other non-tristate shape reaching this boundary must
 * fail loudly, naming what it actually got, per
 * `agent_docs/MEMORY/TRISTATE_UNKNOWN_IS_NEVER_EMPTY_LAW.md`'s "a check
 * that cannot complete must say so ... and refuse" -- applied one layer
 * earlier, where untyped data enters typed code.
 */
function assertValidIdentityLineReadShape(
  read: IdentityLineRead | undefined,
): void {
  if (read === undefined) return;
  if (
    typeof read !== 'object' ||
    read === null ||
    !VALID_IDENTITY_LINE_READ_STATUSES.includes((read as { status?: unknown }).status as string)
  ) {
    throw new Error(
      'IdleFamilyEvidence.supervisors entry is not a tristate IdentityLineRead: ' +
        `expected an object with status one of ${VALID_IDENTITY_LINE_READ_STATUSES.join(', ')}, ` +
        `got ${typeof read === 'string' ? `raw string ${JSON.stringify(read)}` : `${typeof read} ${JSON.stringify(read)}`}. ` +
        'A raw string here means some caller fed readAgentSupervisor/readAgentRole a plain ' +
        'string instead of its tristate result -- the exact defect class closed by ' +
        'identitysilent slices 05, 06, 07, and 10.',
    );
  }
}

/**
 * The recorded supervisor name from a tristate read, or `undefined` for
 * either a genuinely fieldless file or a read that never resolved --
 * callers that need to tell those two apart check
 * `supervisorReadUnresolved` first.
 */
export function resolvedSupervisorName(read: IdentityLineRead | undefined): string | undefined {
  assertValidIdentityLineReadShape(read);
  return read?.status === IdentityLineReadStatus.Found ? read.value : undefined;
}

export function supervisorReadUnresolved(read: IdentityLineRead | undefined): boolean {
  assertValidIdentityLineReadShape(read);
  return read?.status === IdentityLineReadStatus.ReadUnresolved;
}
