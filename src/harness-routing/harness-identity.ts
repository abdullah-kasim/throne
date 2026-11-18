// Harness/model name constants shared by `harness.ts` (launch plumbing) and
// `model-registry.ts` (model data). Split into its own zero-dependency module
// so the two can reference each other's data without a load-time import
// cycle: `harness.ts` reads `MODEL_REGISTRY`, and `model-registry.ts`'s
// entries are declared using these same harness/model name constants. The
// two omni-harness names live here rather than in `omni-harness.ts` (which
// re-exports them for its existing consumers) for the same reason:
// `omni-harness.ts` reads `MODEL_REGISTRY` for its `omni` field, so this
// module importing from it would reopen the cycle it exists to avoid.

export const OMNI_HARNESS_NAMES = {
  CLAUDEY_ALL_OMNI: 'claudey-all-omni',
  CODEXY_ALL_OMNI: 'codexy-all-omni',
} as const;
export type OmniHarness =
  (typeof OMNI_HARNESS_NAMES)[keyof typeof OMNI_HARNESS_NAMES];

export const HARNESS_NAMES = {
  CLAUDE: 'claude',
  CODEX: 'codex',
  OPENCODE: 'opencode',
  PI: 'pi',
  ...OMNI_HARNESS_NAMES,
} as const;
export type Harness = (typeof HARNESS_NAMES)[keyof typeof HARNESS_NAMES];
export type RuntimeHarness = 'claude' | 'codex' | 'opencode' | 'pi';
export const HARNESSES = Object.values(HARNESS_NAMES);

export const REMOVED_HARNESS_REPLACEMENTS: Readonly<Record<string, string>> = {
  omp: 'pi',
};

export function removedHarnessMessage(harness: string): string | undefined {
  const name = harness.trim();
  if (!Object.hasOwn(REMOVED_HARNESS_REPLACEMENTS, name)) return undefined;
  return `the ${name} harness was removed from the throne; use the ${REMOVED_HARNESS_REPLACEMENTS[name]} harness instead`;
}

export const MODEL_NAMES = {
  FABLE: 'fable',
  OPUS: 'opus',
  SONNET: 'sonnet',
  HAIKU: 'haiku',
  GPT_5_6_SOL: 'gpt-5.6-sol',
  GPT_5_6_TERRA: 'gpt-5.6-terra',
  GPT_5_6_LUNA: 'gpt-5.6-luna',
  GPT_5_5: 'gpt-5.5',
  GPT_5_4: 'gpt-5.4',
  GPT_5_4_MINI: 'gpt-5.4-mini',
  DEEPSEEK_V4_FLASH: 'opencode-go/deepseek-v4-flash',
  FLASH: 'flash',
  PRO: 'pro',
} as const;
