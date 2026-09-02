import { herdrAgentNameRefusal } from '../herdr/herdr-identity.service.ts';
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from './role-word-union.ts';

export interface StoredObjectiveEvidence {
  objective_code?: unknown;
  non_campaign?: unknown;
}

export type ObjectiveContract =
  | { kind: 'campaign'; objectiveCode: string }
  | { kind: 'non-campaign' };

export type ObjectiveContractResult =
  | { ok: true; contract?: ObjectiveContract }
  | { ok: false; reason: string };

export type ObjectiveEvidenceRole = 'alpha' | 'shadow';

const OBJECTIVE_CODE_PATTERN = /^[A-Za-z0-9]+$/;
const CANONICAL_SLICE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUEUE_ADDRESSING_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function canonicalObjectiveCode(value: string): string | undefined {
  return OBJECTIVE_CODE_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** Validates a stored queue item's `--objective-code` addressing token: lowercase
 *  ASCII alphanumeric segments optionally joined by single hyphens, with no
 *  leading/trailing hyphen and no empty segment. This is a wider acceptance
 *  set than `canonicalObjectiveCode` and is a deliberately separate decision
 *  from it — it addresses stored queue items, it does not mint or canonicalize
 *  a campaign name. */
export function queueAddressingObjectiveCode(value: string): string | undefined {
  const lowered = value.toLowerCase();
  return QUEUE_ADDRESSING_CODE_PATTERN.test(lowered) ? lowered : undefined;
}

export function nameCarriesObjectiveCode(
  role: ObjectiveEvidenceRole,
  name: string,
  objectiveCode: string,
): boolean {
  const prefix = `${role}-${objectiveCode}-`;
  return name.startsWith(prefix) && name.length > prefix.length;
}

export function objectiveContractFromStoredEvidence(opts: {
  agentName: string;
  role: ObjectiveEvidenceRole;
  evidence: StoredObjectiveEvidence | null;
}): ObjectiveContractResult {
  const { agentName, role, evidence } = opts;
  if (evidence === null) {
    return {
      ok: false,
      reason: `stored objective evidence for "${agentName}" is not readable`,
    };
  }

  const hasObjectiveCode = hasOwn(evidence, 'objective_code');
  const hasNonCampaign = hasOwn(evidence, 'non_campaign');
  if (hasObjectiveCode === hasNonCampaign) {
    return {
      ok: false,
      reason: hasObjectiveCode
        ? `stored objective evidence for "${agentName}" has contradictory ` +
          'objective_code and non_campaign fields; it must contain exactly one'
        : `stored objective evidence for "${agentName}" must contain exactly one ` +
          'of objective_code or non_campaign',
    };
  }

  if (hasNonCampaign) {
    if (evidence.non_campaign !== true) {
      return {
        ok: false,
        reason: `stored non_campaign evidence for "${agentName}" is invalid`,
      };
    }
    return { ok: true, contract: { kind: 'non-campaign' } };
  }

  if (typeof evidence.objective_code !== 'string') {
    return {
      ok: false,
      reason: `stored objective_code evidence for "${agentName}" is not a string`,
    };
  }
  const objectiveCode = canonicalObjectiveCode(evidence.objective_code);
  if (objectiveCode === undefined || objectiveCode !== evidence.objective_code) {
    return {
      ok: false,
      reason:
        `stored objective_code evidence for "${agentName}" is non-canonical: ` +
        `"${evidence.objective_code}"`,
    };
  }
  if (!nameCarriesObjectiveCode(role, agentName, objectiveCode)) {
    return {
      ok: false,
      reason:
        `stored objective_code evidence for "${agentName}" does not begin ` +
        `"${role}-${objectiveCode}-" and does not match its registered role name`,
    };
  }
  return { ok: true, contract: { kind: 'campaign', objectiveCode } };
}

export function objectiveContractFromAlphaEvidence(
  alphaName: string,
  evidence: StoredObjectiveEvidence | null,
): ObjectiveContractResult {
  if (evidence === null) {
    return {
      ok: false,
      reason: `supervising Alpha "${alphaName}" has no readable spawn evidence`,
    };
  }

  const hasObjectiveCode = hasOwn(evidence, 'objective_code');
  const hasNonCampaign = hasOwn(evidence, 'non_campaign');
  if (hasObjectiveCode || hasNonCampaign) {
    return objectiveContractFromStoredEvidence({
      agentName: alphaName,
      role: 'alpha',
      evidence,
    });
  }

  const resolved = resolveCanonicalRoleWord(alphaName, LIVE_ROLE_WORD_UNION);
  const legacyToken =
    resolved?.role === 'alpha'
      ? /^([a-z0-9]+)-.+$/.exec(resolved.rest)?.[1]
      : undefined;
  if (legacyToken === undefined) {
    return {
      ok: false,
      reason:
        `pre-contract supervising Alpha "${alphaName}" has no first canonical ` +
        'token after "alpha-"',
    };
  }
  return {
    ok: true,
    contract: { kind: 'campaign', objectiveCode: legacyToken },
  };
}

/** Only the Regent may supervise a new Alpha spawn. A Stager never spawns an
 *  Alpha itself — it relays a completed plan to the Regent and asks the
 *  Regent to launch it. */
export function isAlphaSpawnerSupervisorName(supervisor: string): boolean {
  return supervisor.trim().toLowerCase() === 'regent';
}

/** Only a Stager may file a queue objective (Lord, 2026-08-21). The Lord caps
 *  what the court is allowed to be working on, and he does that through the one
 *  role that talks to him directly; every other role reports findings and lets
 *  him decide whether they become work. An Alpha or Shadow that files its own
 *  follow-up work is the manufactured-scope failure `AGENTS.md` already forbids
 *  in prose, and the Regent filing on a campaign's behalf is that same outcome
 *  with an extra hop. Enforced at `add-to-queue`'s entrance, which is the only
 *  path that creates a queue row (`insertItem`'s sole non-migration caller). */
export function isQueueFilerRoleName(role: string): boolean {
  return role.trim().toLowerCase() === 'stager';
}

export function newAgentObjectiveContract(opts: {
  role: string;
  name: string;
  supervisor: string;
  objectiveCode?: string;
  nonCampaign: boolean;
  supervisorEvidence?: StoredObjectiveEvidence | null;
}): ObjectiveContractResult {
  const role = opts.role.trim().toLowerCase();
  if (role !== 'alpha' && role !== 'shadow') {
    return { ok: true };
  }

  if (opts.objectiveCode !== undefined && opts.nonCampaign) {
    return {
      ok: false,
      reason: '--objective-code and --non-campaign are mutually exclusive',
    };
  }

  if (role === 'alpha') {
    if (!isAlphaSpawnerSupervisorName(opts.supervisor)) {
      return {
        ok: false,
        reason:
          `new Alpha launches are admitted only for a "Regent" --supervisor; ` +
          `got "${opts.supervisor}". A Stager never spawns an Alpha itself — ` +
          'relay the completed plan to the Regent and ask the Regent to launch it.',
      };
    }
    if (opts.nonCampaign) {
      return { ok: true, contract: { kind: 'non-campaign' } };
    }
    if (opts.objectiveCode === undefined) {
      return {
        ok: false,
        reason:
          'new Alpha launches require --objective-code <code> or the loud ' +
          '--non-campaign exemption',
      };
    }
    const canonical = canonicalObjectiveCode(opts.objectiveCode);
    if (canonical === undefined) {
      return {
        ok: false,
        reason:
          `invalid objective code "${opts.objectiveCode}"; use one ASCII ` +
          'alphanumeric token',
      };
    }
    if (!nameCarriesObjectiveCode('alpha', opts.name, canonical)) {
      return {
        ok: false,
        reason:
          `Alpha name "${opts.name}" must begin "alpha-${canonical}-" for ` +
          `objective code "${canonical}"`,
      };
    }
    return { ok: true, contract: { kind: 'campaign', objectiveCode: canonical } };
  }

  if (opts.objectiveCode !== undefined) {
    return {
      ok: false,
      reason:
        'new Shadow launches inherit objective code from their supervising Alpha; ' +
        'do not pass --objective-code',
    };
  }
  if (opts.nonCampaign) {
    return { ok: true, contract: { kind: 'non-campaign' } };
  }

  const inherited = objectiveContractFromAlphaEvidence(
    opts.supervisor,
    opts.supervisorEvidence ?? null,
  );
  if (!inherited.ok) {
    return inherited;
  }
  if (inherited.contract?.kind !== 'campaign') {
    return {
      ok: false,
      reason:
        `supervising Alpha "${opts.supervisor}" is explicitly non-campaign; ` +
        'use --non-campaign for non-campaign Shadow infrastructure',
    };
  }
  const objectiveCode = inherited.contract.objectiveCode;
  if (!nameCarriesObjectiveCode('shadow', opts.name, objectiveCode)) {
    return {
      ok: false,
      reason:
        `Shadow name "${opts.name}" must begin "shadow-${objectiveCode}-" to ` +
        `match supervising Alpha "${opts.supervisor}"`,
    };
  }
  return { ok: true, contract: inherited.contract };
}

export function explicitResumeObjectiveConflict(opts: {
  objectiveCode?: string;
  nonCampaign: boolean;
  storedEvidence: StoredObjectiveEvidence;
}): string | undefined {
  if (opts.objectiveCode === undefined && !opts.nonCampaign) {
    return undefined;
  }
  if (opts.objectiveCode !== undefined && opts.nonCampaign) {
    return '--objective-code and --non-campaign are mutually exclusive';
  }

  const hasObjectiveCode = hasOwn(opts.storedEvidence, 'objective_code');
  const hasNonCampaign = hasOwn(opts.storedEvidence, 'non_campaign');
  if (hasObjectiveCode && hasNonCampaign) {
    return 'stored spawn evidence has contradictory objective_code and non_campaign fields';
  }

  if (opts.objectiveCode !== undefined) {
    const canonical = canonicalObjectiveCode(opts.objectiveCode);
    if (canonical === undefined) {
      return `explicit --objective-code "${opts.objectiveCode}" is invalid`;
    }
    if (!hasObjectiveCode || opts.storedEvidence.objective_code !== canonical) {
      return (
        `explicit --objective-code "${canonical}" conflicts with stored ` +
        `objective_code "${String(opts.storedEvidence.objective_code)}"`
      );
    }
    return undefined;
  }

  return hasNonCampaign && opts.storedEvidence.non_campaign === true
    ? undefined
    : 'explicit --non-campaign conflicts with stored campaign evidence';
}

export function canonicalShadowNameFromAlpha(opts: {
  alphaName: string;
  sliceId: string;
  alphaEvidence: StoredObjectiveEvidence | null;
}): { ok: true; name: string } | { ok: false; reason: string } {
  if (!CANONICAL_SLICE_ID_PATTERN.test(opts.sliceId)) {
    return {
      ok: false,
      reason:
        `slice id "${opts.sliceId}" must be lowercase ASCII alphanumeric words ` +
        'separated by single hyphens',
    };
  }
  const inherited = objectiveContractFromAlphaEvidence(
    opts.alphaName,
    opts.alphaEvidence,
  );
  if (!inherited.ok) {
    return inherited;
  }
  if (inherited.contract?.kind !== 'campaign') {
    return {
      ok: false,
      reason: `supervising Alpha "${opts.alphaName}" is explicitly non-campaign`,
    };
  }
  const name = `shadow-${inherited.contract.objectiveCode}-${opts.sliceId}`;
  const nameRefusal = herdrAgentNameRefusal(name);
  return nameRefusal === undefined
    ? { ok: true, name }
    : { ok: false, reason: nameRefusal };
}

