// Requirement: every model's primary harness is its NATIVE one, and nobody
// repoints it at a non-native harness.
//
// The Lord, 2026-08-29: "lets switch all harnesses back to native. and make
// sure we dont change the native harnesses to a non native one. add comment as
// necessary in case someone does."
//
// This is the "in case someone does" half. The comment in `model-registry.ts`
// tells a reader why; this test stops the reader who did not read it.
//
// WHY THIS IS WORTH A TEST AND NOT JUST A COMMENT. It was done once, on
// 2026-08-27. The diff looked like four
// words. The blast radius was not visible from it: `PRIMARY_CLAUDE_MODELS` in
// `harness.ts` derived itself from `harness === CLAUDE`, so moving the
// primaries EMPTIED that set, which made `isGptModel("fable")` return true,
// which swallowed every Anthropic pair into `LEGACY_RESUME_ONLY_MODEL_PAIRS`,
// which removed them from `CONFIGURED_MODEL_PAIRS`, which killed config load
// for any preset naming one — `Invalid config.user.ts steering entry
// "SonnetLow"`, i.e. every throne command dead at startup. Four words, whole
// court down.
//
// A non-native harness is chosen by the PRESET (`config.user.ts`
// `activeHarness`, or a pair naming it) — a reversible, court-wide,
// dated decision. Rewriting these rows instead changes what every model IS,
// everywhere, permanently, and for every caller that never asked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HARNESS_NAMES } from "./harness-identity.ts";
import { MODEL_REGISTRY } from "./model-registry.ts";

/** The harness each model family is native to. A model whose provider runs its
 *  own first-party CLI belongs to that CLI; anything else is a wrapper. */
const NATIVE_HARNESS_BY_FAMILY = {
  anthropic: HARNESS_NAMES.CLAUDE,
  chatgpt: HARNESS_NAMES.CODEX,
} as const;

/** Family is read from the model's own identity, not from the field under
 *  test — deriving the expectation from the value being checked would make
 *  this test vacuous. */
function familyOf(model: string): keyof typeof NATIVE_HARNESS_BY_FAMILY | undefined {
  if (/^(fable|opus|sonnet|haiku)$/.test(model)) return "anthropic";
  if (model.startsWith("gpt-")) return "chatgpt";
  return undefined;
}

test("every model's primary harness is the one its provider runs natively", () => {
  const checked: string[] = [];
  for (const entry of MODEL_REGISTRY) {
    const family = familyOf(entry.model);
    if (family === undefined) continue; // e.g. the disabled opencode-go row
    checked.push(entry.model);
    assert.equal(
      entry.harness,
      NATIVE_HARNESS_BY_FAMILY[family],
      `"${entry.model}" must stay on its native harness. A non-native harness ` +
        `is selected by the preset in config.user.ts, never by repointing this ` +
        `row — see the standing comment at the top of MODEL_REGISTRY. Revert ` +
        `the row; do not relax this test.`,
    );
  }
  assert.ok(
    checked.length >= 10,
    `expected to check every Anthropic and ChatGPT model, only saw ${checked.length}`,
  );
});
