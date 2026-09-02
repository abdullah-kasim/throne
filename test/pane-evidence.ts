/**
 * Wrap-tolerant matching for terminal pane evidence.
 *
 * `herdr agent read` returns pane text hard-wrapped at the pane's own width,
 * and `--source recent-unwrapped` does not restore logical lines in this herdr
 * build: measured live, the maximum line length is identical across `visible`,
 * `recent` and `recent-unwrapped`, and equals the pane width (63 columns on
 * three panes of one layout, 108 on a fourth). Wrapping splits mid-token and
 * indents the continuation with the pane's own gutter.
 *
 * A needle wider than the pane therefore can NEVER appear contiguously in pane
 * evidence, however correctly the product behaved. A 128-hex SHA-512 receipt is
 * already ~2x a typical pane width.
 *
 * Collapsing removes ANSI control sequences and every whitespace character from
 * both sides of the comparison. That restores the logical run without relaxing
 * the assertion: the byte count, the digest and the path must still match
 * exactly. Pane lines are never right-padded, so the removal itself discards
 * no payload character.
 *
 * Collapsing does NOT make the pane a lossless channel, though: see
 * `renderedDigestMatches` for the loss that survives it.
 */

const ANSI_CONTROL_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

export function collapsePaneEvidence(text: string): string {
  return text.replace(ANSI_CONTROL_SEQUENCE, '').replace(/\s+/gu, '');
}

/**
 * Lowest number of a 128-character digest's own characters that must survive
 * rendering. 120 tolerates the observed single-character boundary loss with
 * room for a few more, and 120 hex characters still pin 480 bits.
 */
export const DIGEST_RENDER_FLOOR = 120;

/**
 * Decide whether pane-rendered text carries `expected` as a digest receipt.
 *
 * A terminal pane is a LOSSY channel for a token wider than the pane. Captured
 * live (canary-cdx-lg-404704 evidence dump), a SHA-512 receipt rendered as
 * 59 + 59 + 9 = 127 of its 128 characters, wrapping at exactly the pane's
 * 63-column content edge -- the column where a terminal's deferred-wrap
 * handling can drop the boundary character. A run minutes earlier rendered all
 * 128. Demanding every character therefore decides the gate on terminal
 * repaint luck rather than on whether the recipient consumed the payload.
 *
 * The gate stays binding by asserting what a repaint cannot fake. Dropping
 * characters is the ONLY corruption reflow introduces: it never inserts,
 * substitutes or reorders them. So the rendered digest must be an in-order
 * SUBSEQUENCE of the expected digest, anchored at its first character, and
 * retain at least `DIGEST_RENDER_FLOOR` of the 128. The digest of any other
 * byte string fails immediately -- embedding 120 characters in order inside a
 * different 128-character hex string is not something a wrong digest does by
 * accident, and `test/pane-evidence.test.ts` carries the mutation witnesses.
 */
export function renderedDigestMatches(
  collapsed: string,
  expected: string,
): boolean {
  const target = expected.toLowerCase();
  const lowered = collapsed.toLowerCase();

  // The same receipt reaches the pane under two spellings: the raw stdout line
  // (`sha512 <digest>`) and the TUI's prose re-render (`- SHA-512: <digest>`),
  // and a capture may carry both. Try every marker rather than assuming which
  // one rendered last.
  for (const marker of lowered.matchAll(/sha-?512:?/gu)) {
    const start = (marker.index ?? 0) + marker[0].length;
    const observed = (lowered.slice(start).match(/^[0-9a-f]+/u) ?? [''])[0].slice(
      0,
      target.length,
    );
    if (observed.length < DIGEST_RENDER_FLOOR || observed[0] !== target[0]) {
      continue;
    }

    let cursor = 0;
    let embedded = true;
    for (const character of observed) {
      cursor = target.indexOf(character, cursor);
      if (cursor < 0) {
        embedded = false;
        break;
      }
      cursor += 1;
    }
    if (embedded) return true;
  }
  return false;
}
