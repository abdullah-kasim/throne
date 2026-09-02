// The no-internals check for squash commit messages (`make-squash-commit`,
// and later `merge-git-tree` once it accepts a message — see the SQUASH
// queue entry). The Lord banned throne machinery vocabulary from permanent
// repo history: agent names, role words, slice references, gate
// identifiers, campaign/delivery machinery nouns, and AI co-authorship
// trailers. This check must REFUSE rather than strip or invent around a
// hit — the caller names the offending token and retries with real prose.
//
// Each pattern below is intentionally broad rather than narrow: a check
// narrower than its claim reports clean and is believed (the queue records
// one such regex missing ten files in one night). Enumerate the shape, not
// a sample of it.

interface InternalsPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

const INTERNALS_PATTERNS: readonly InternalsPattern[] = [
  // Agent names in every observed spelling: alpha-<slug>, shadow-<slug>.
  {
    label: "agent name",
    pattern: /\b(?:alpha|shadow)-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\b/i,
  },
  // Terminal-gate identifiers: 99a..99z.
  { label: "gate identifier", pattern: /\b99[a-z]\b/i },
  // Slice references in every spelling: "slice 01", "slice cts-NN".
  { label: "slice reference", pattern: /\bslice[\s-]+[a-z0-9][a-z0-9-]*\b/i },
  // Bare role words, even without a name/hyphen attached.
  { label: "role word", pattern: /\b(?:alpha|shadow|regent)\b/i },
  // Campaign-machinery nouns: absorb/reap/spawn/worktree/herdr/throne/
  // ledger/campaign/gate, and the delivery-machinery phrase "deliver <x>".
  {
    label: "machinery vocabulary",
    pattern:
      /\b(?:absorb(?:ed|ing)?|reap(?:ed|ing)?|spawn(?:ed|ing)?|worktree|herdr|throne|ledger|campaign|gate)\b/i,
  },
  // AI co-authorship trailers.
  {
    label: "AI co-authorship trailer",
    pattern: /co-authored-by:?[^\n]*\b(?:claude|anthropic|copilot|chatgpt|openai|gpt)\b/i,
  },
];

export interface InternalsHit {
  readonly token: string;
  readonly label: string;
}

/** Scan `message` for throne-internals vocabulary; return the first hit
 *  (the exact matched substring, and which category caught it), or
 *  `undefined` when the message is clean. Order is priority, not severity —
 *  callers report only the first hit and ask for a retry. */
export function findInternalsToken(message: string): InternalsHit | undefined {
  for (const { label, pattern } of INTERNALS_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return { token: match[0], label };
  }
  return undefined;
}
