// identity.md's own `- **Role:** ` line has been observed carrying
// inconsistent casing for the same semantic role across different spawn
// paths (`alpha` vs `Alpha`) -- confirmed live via `throne-cli agent-statuses`
// column 2: a real Alpha's role read back lowercase while a Shadow's read
// back capitalized. `Alpha`/`Shadow` are the only two roles ever observed to
// disagree; every other role (Regent, Stager, Agent, ad-hoc custom roles)
// passes through unchanged. One vocabulary, shared by the identity.md writer
// (new agents get canonical casing going forward) and reader (existing
// lowercase files still resolve correctly), so neither can drift from the
// other again.
const CANONICAL_IDENTITY_ROLE_NAMES = ['Alpha', 'Shadow'] as const;

export function canonicalizeIdentityRole(rawRole: string): string {
  const trimmed = rawRole.trim();
  const canonical = CANONICAL_IDENTITY_ROLE_NAMES.find(
    (name) => name.toLowerCase() === trimmed.toLowerCase(),
  );
  return canonical ?? trimmed;
}
