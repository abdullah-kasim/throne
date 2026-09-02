/** The one durable spelling used after a live Regent identity is proved. */
export const CANONICAL_REGENT_AUTHORITY = "Regent" as const;

/**
 * Live Herdr identity lookup is case-insensitive, while durable authority
 * evidence is intentionally canonical. Never persist the raw display form.
 */
export function canonicalRegentAuthority(
  liveIdentity: string,
): typeof CANONICAL_REGENT_AUTHORITY | undefined {
  return liveIdentity.toLowerCase() === "regent"
    ? CANONICAL_REGENT_AUTHORITY
    : undefined;
}

export function isCanonicalRegentAuthority(
  authority: string,
): authority is typeof CANONICAL_REGENT_AUTHORITY {
  return authority === CANONICAL_REGENT_AUTHORITY;
}
