import {
  nameCarriesObjectiveCode,
  objectiveContractFromAlphaEvidence,
  type StoredObjectiveEvidence,
} from "../shared-policy/objective-contract.ts";
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from "../shared-policy/role-word-union.ts";

const REMEDIES =
  "name the supervising Alpha explicitly with --alpha <alpha-name>, or pass " +
  "--non-campaign for a deliberate non-campaign tree";

export function campaignShadowToken(name: string): string | undefined {
  const resolved = resolveCanonicalRoleWord(name, LIVE_ROLE_WORD_UNION);
  if (resolved?.role !== "shadow") return undefined;
  return /^([a-z0-9]+)-.+$/.exec(resolved.rest)?.[1];
}

export async function resolveCampaignAlpha(query: {
  shadowName: string;
  explicitAlpha?: string;
  registeredAgents: readonly string[];
  readAlphaEvidence: (
    alphaName: string,
  ) => Promise<StoredObjectiveEvidence | null>;
}): Promise<{ ok: true; alphaName: string } | { ok: false; reason: string }> {
  const token = campaignShadowToken(query.shadowName);
  if (token === undefined) {
    return {
      ok: false,
      reason: `"${query.shadowName}" is not a campaign Shadow name (shadow-<code>-…), so no supervising Alpha resolves for it`,
    };
  }
  const admit = async (alphaName: string) =>
    objectiveContractFromAlphaEvidence(
      alphaName,
      await query.readAlphaEvidence(alphaName),
    );
  if (query.explicitAlpha !== undefined) {
    if (!query.registeredAgents.includes(query.explicitAlpha)) {
      return {
        ok: false,
        reason: `--alpha "${query.explicitAlpha}" names no registered Alpha (no data/${query.explicitAlpha}/identity.md); ${REMEDIES}`,
      };
    }
    const contract = await admit(query.explicitAlpha);
    if (!contract.ok)
      return { ok: false, reason: `${contract.reason}; ${REMEDIES}` };
    if (contract.contract?.kind !== "campaign") {
      return {
        ok: false,
        reason: `--alpha "${query.explicitAlpha}" is explicitly non-campaign, so it owns no campaign branch for "${query.shadowName}"; ${REMEDIES}`,
      };
    }
    if (
      !nameCarriesObjectiveCode(
        "shadow",
        query.shadowName,
        contract.contract.objectiveCode,
      )
    ) {
      return {
        ok: false,
        reason: `--alpha "${query.explicitAlpha}" carries objective code "${contract.contract.objectiveCode}", which does not admit Shadow name "${query.shadowName}"; ${REMEDIES}`,
      };
    }
    return { ok: true, alphaName: query.explicitAlpha };
  }
  const matches: string[] = [];
  for (const candidate of query.registeredAgents) {
    if (
      resolveCanonicalRoleWord(candidate, LIVE_ROLE_WORD_UNION)?.role !==
      "alpha"
    )
      continue;
    const contract = await admit(candidate);
    if (
      contract.ok &&
      contract.contract?.kind === "campaign" &&
      contract.contract.objectiveCode === token
    )
      matches.push(candidate);
  }
  if (matches.length === 1) return { ok: true, alphaName: matches[0]! };
  if (matches.length === 0)
    return {
      ok: false,
      reason: `no registered Alpha's campaign evidence carries objective code "${token}" for "${query.shadowName}"; ${REMEDIES}`,
    };
  return {
    ok: false,
    reason: `multiple registered Alphas (${matches.join(", ")}) carry objective code "${token}" for "${query.shadowName}"; ${REMEDIES}`,
  };
}
