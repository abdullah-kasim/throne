import {
  REAPABLE_MARKER_CANCELLED,
  REAPABLE_MARKER_COMPLETED,
  REAPABLE_MARKER_FAIL,
  REAPABLE_MARKER_TASK_RESTART_REQUIRED,
  parseBlockedByMarkers,
  parseReapableMarkers,
} from './greppable-marker.ts';

export type LastMessageTagState =
  | { readonly kind: 'reapable' }
  | { readonly kind: 'reapable-failed' }
  | { readonly kind: 'retired-reapable-marker' }
  | { readonly kind: 'blocked'; readonly blockedBy: readonly string[] }
  | { readonly kind: 'busy'; readonly running: string }
  | { readonly kind: 'unmarked' }
  | { readonly kind: 'unreadable' };

// Herdr renders attributed turns with a leading `›`; accept both the raw
// transcript form and the normalized form so stale markers before the latest
// empty/ordinary turn cannot leak into the current-message classification.
const ATTRIBUTED_PROMPT_LINE =
  /^[ \t]*(?:›[ \t]*)?[A-Za-z0-9][A-Za-z0-9._-]*[ \t]+said:[ \t]/;

// Assistant turns are bulleted, but the glyph is HARNESS-SPECIFIC: Codex panes
// render U+2022 BULLET (`•`) while Claude Code panes render U+25CF BLACK CIRCLE
// (`●`). They are different characters and matching only one silently blinds
// this module to the other harness entirely — a Claude agent could never be
// seen publishing {"blocked":true}, so every sweep re-notified it forever.
// Observed live 2026-08-08 once the active preset routed every role to
// claude/sonnet. Any new harness's glyph must be added here.
const ASSISTANT_TURN_GLYPHS = '•●';
const ASSISTANT_TURN_LINE = new RegExp(`^[ \\t]*[${ASSISTANT_TURN_GLYPHS}][ \\t]+`);
const ASSISTANT_TURN_PREFIX = new RegExp(`^[ \\t]*[${ASSISTANT_TURN_GLYPHS}][ \\t]+`);
const TURN_BOUNDARY_LINE = new RegExp(`^[ \\t]*(?:[${ASSISTANT_TURN_GLYPHS}]|›)[ \\t]+`);

// The indented pane FOOTER (model · effort · cwd) ends the last turn. Its shape is
// also harness-specific: Codex writes `gpt-5.6-luna low · /path` (footer token
// first) while Claude Code writes `Sonnet 5 · effort:low · /path`, which the old
// first-token-then-` · /` pattern could not match — so a Claude footer was absorbed
// into the message block and broke standalone-JSON classification whenever the
// separator rule above did not fire first. Match the ` · <path>` segment anywhere
// on an indented line instead of anchoring it to the first token.
const STATUS_FOOTER_LINE = /^[ \t]+\S.*\s·\s\//;

// Claude Code panes append a live PROGRESS line after the assistant turn, e.g.
// `✻ Brewed for 5s` or `✻ Sautéed for 5m 17s · 1 shell still running`. The glyph is
// U+273B TEARDROP-SPOKED ASTERISK (e2 9c bb) and the verb varies. It is chrome,
// never assistant content, but it is NOT indented, so the footer rule above does
// not catch it. Left unbounded it is appended to the last message block and makes
// a standalone `{"blocked":true}` fail JSON.parse — the agent publishes the marker
// correctly and is still swept. Verified against a LIVE pane on 2026-08-08.
const PROGRESS_LINE = /^[ \t]*✻[ \t]/;

// Herdr's Claude-pane detector reports `agent_status: idle` whenever the model is
// not generating a token — it cannot see WORK the agent is waiting on. A Claude
// agent that launched a background shell (a multi-minute `npm test`, say) and is
// waiting for it therefore looks IDLE to herdr while being anything but, and
// no-idling flags its whole family every sweep. The pane itself says otherwise:
// the live progress line carries a running-work suffix, e.g.
//   ✻ Cooked for 42s · 1 shell still running
//   ✻ Worked for 3m 21s · 2 monitors still running
// A bare `✻ Brewed for 5s` has no such suffix and is NOT busy — that is an agent
// genuinely waiting on nothing. Observed live 2026-08-08 on shadow-sakey-99a,
// which herdr reported idle while it held a running test shell.
//
// Scanned only in the TAIL of the capture: the progress line is live pane chrome
// at the bottom, so an identical string further up is stale scrollback from a
// finished run and must not count.
// Two shapes, because the pane words background work differently depending on
// WHAT it is waiting on:
//   ✻ Cooked for 42s · 1 shell still running      (background shell/monitor)
//   ✻ Waiting for 1 background agent to finish   (a spawned sub-agent/fork)
// The second carries no `· N ... still running` suffix at all, so the first
// pattern alone reported an agent blocked on a fork as NOT busy and its family
// was swept. Found by reading a live pane after the initial fix shipped — the
// synthetic fixtures only ever exercised the shell wording.
//
// A pane holding more than one kind of resource lists them comma-separated
// before the shared suffix, e.g. `1 shell, 1 monitor still running`. Observed
// live in the 2026-08-11 escalation for shadow-nia-99c's pane. One resource
// item repeated an arbitrary number of times, joined by `, ` or ` and `.
const RUNNING_WORK_RESOURCE_ITEM = '\\d+[ \\t]+(?:shell|monitor|task|command)s?';
const RUNNING_WORK_RESOURCE_LIST =
  `${RUNNING_WORK_RESOURCE_ITEM}(?:(?:,[ \\t]*|[ \\t]+and[ \\t]+)${RUNNING_WORK_RESOURCE_ITEM})*`;
const RUNNING_WORK_SUFFIX = new RegExp(
  `✻[^\\n]*·[ \\t]*(${RUNNING_WORK_RESOURCE_LIST}[ \\t]+still[ \\t]+running)`,
);
const AWAITING_AGENT_LINE =
  /✻[ \t]*(Waiting[ \t]+for[ \t]+\d+[ \t]+background[ \t]+agents?[ \t]+to[ \t]+finish)/i;
const LIVE_TAIL_LINES = 15;

/** The live background work a pane reports, or undefined when it reports none. */
export function liveBackgroundWork(output: string): string | undefined {
  const tail = output.split('\n').slice(-LIVE_TAIL_LINES).join('\n');
  return (
    RUNNING_WORK_SUFFIX.exec(tail)?.[1] ?? AWAITING_AGENT_LINE.exec(tail)?.[1]
  );
}

/** Every assistant-turn message block found in `output`, oldest first. Each
 *  entry is the same text `lastMessageBlock` would return if that turn were
 *  the last one in the capture — chrome (footers, progress lines, turn
 *  boundaries) stripped the same way. Falls back to the single attributed-
 *  prompt-boundary block (or the whole capture) when no assistant-turn glyph
 *  is present at all, matching `lastMessageBlock`'s own fallback. */
export function assistantMessageBlocks(output: string): string[] {
  const lines = output.split('\n');
  const assistantIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ASSISTANT_TURN_LINE.test(lines[i]!)) {
      assistantIndexes.push(i);
    }
  }
  if (assistantIndexes.length === 0) {
    let lastBoundaryIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (ATTRIBUTED_PROMPT_LINE.test(lines[i]!)) {
        lastBoundaryIndex = i;
      }
    }
    return [
      lastBoundaryIndex === -1
        ? output
        : lines.slice(lastBoundaryIndex + 1).join('\n'),
    ];
  }
  return assistantIndexes.map((startIndex) => {
    const block: string[] = [
      lines[startIndex]!.replace(ASSISTANT_TURN_PREFIX, ''),
    ];
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (
        TURN_BOUNDARY_LINE.test(line) ||
        /^[─━-]{8,}/.test(line.trim()) ||
        STATUS_FOOTER_LINE.test(line) ||
        PROGRESS_LINE.test(line)
      ) {
        break;
      }
      block.push(line);
    }
    return block.join('\n').trim();
  });
}

export function lastMessageBlock(output: string): string {
  const blocks = assistantMessageBlocks(output);
  return blocks[blocks.length - 1] ?? '';
}

/** The standalone `{"reapable":"<status>"}` vocabulary, mirroring the marker set.
 *  Same discipline as the blocked marker: the WHOLE latest message must be this
 *  one-key object, so a status quoted inside prose never speaks for the agent. */
const STANDALONE_REAPABLE_STATUSES: Readonly<Record<string, string>> = {
  completed: REAPABLE_MARKER_COMPLETED,
  cancelled: REAPABLE_MARKER_CANCELLED,
  task_restart_required: REAPABLE_MARKER_TASK_RESTART_REQUIRED,
  fail: REAPABLE_MARKER_FAIL,
};

// The `{"blocked":true}` marker must be recognized ANYWHERE in the latest
// message, not only when it is the whole trimmed message: a courteous
// acknowledgement in the same turn (or any surrounding prose) must not hide
// it. Anchored so it cannot fire on an incidental mention of the literal
// string inside a larger word, a quoted string literal, or a code span —
// neither the character before nor after the object may be a word character
// or a quote. Ordinary whitespace variation inside the object is allowed
// (`{"blocked":true}` / `{"blocked": true}`); this is deliberately not a
// general embedded-JSON scanner, so an agent discussing this exact marker
// syntax unquoted in prose remains a known, accepted false-positive risk.
const BLOCKED_MARKER_ANYWHERE_PATTERN =
  /(?<![\w"])\{\s*"blocked"\s*:\s*true\s*\}(?![\w"])/;
const REAPABLE_CLAIM_ANYWHERE_PATTERN =
  /(?<![\w"])\{\s*"reapable"\s*:\s*"(completed|cancelled|task_restart_required|fail)"\s*\}(?![\w"])/i;

/** A single-key object literal, or undefined when `text` is not one. */
function standaloneSingleKeyObject(
  text: string,
): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1
    ) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Ordinary agent output is not JSON.
  }
  return undefined;
}

export function classifyLastMessageTags(text: string): LastMessageTagState {
  const trimmed = text.trim();
  const standalone = standaloneSingleKeyObject(trimmed);
  if (standalone?.blocked === true || BLOCKED_MARKER_ANYWHERE_PATTERN.test(trimmed)) {
    return { kind: 'blocked', blockedBy: parseBlockedByMarkers(text) };
  }
  // Standalone reapable, the counterpart of the blocked marker:
  //   {"reapable":"completed"} {"reapable":"cancelled"}
  //   {"reapable":"task_restart_required"} {"reapable":"fail"}
  // An agent can end its turn with one line and be classified exactly, without
  // embedding a `"reapable_status"` field in surrounding prose.
  const reapableStatus = readReapabilityClaimStatus(trimmed);
  if (reapableStatus !== undefined) {
    const marker = STANDALONE_REAPABLE_STATUSES[reapableStatus.toLowerCase()];
    if (marker !== undefined) {
      return marker === REAPABLE_MARKER_FAIL
        ? { kind: 'reapable-failed' }
        : { kind: 'reapable' };
    }
  }
  const markers = parseReapableMarkers(text);
  // Compare against the MARKER CONSTANT, not a bare status word: the parser
  // returns raw markers like `__REAPABLE_FAIL__`, so an `includes('REAPABLE_FAIL')`
  // element comparison never matched and every FAIL-marked agent was classified
  // plain `reapable` — i.e. advertised to the Regent as a completed Alpha ready
  // for lifecycle cleanup, with the "supervisor repair is required before reap"
  // exclusion never firing. Fixed 2026-08-08.
  if (markers.includes(REAPABLE_MARKER_FAIL)) {
    return { kind: 'retired-reapable-marker' };
  }
  if (markers.length > 0) {
    return { kind: 'retired-reapable-marker' };
  }
  return { kind: 'unmarked' };
}

export function hasReapabilityClaim(text: string): boolean {
  return classifyLastMessageTags(text).kind === 'reapable';
}

export type ReapabilityClaimStatus =
  | 'completed'
  | 'cancelled'
  | 'task_restart_required'
  | 'fail';

/** Classify the canonical exact or anchored-anywhere reapability claim. */
export function readReapabilityClaimStatus(
  text: string,
): ReapabilityClaimStatus | undefined {
  const trimmed = text.trim();
  const standalone = standaloneSingleKeyObject(trimmed);
  const status =
    typeof standalone?.reapable === 'string'
      ? standalone.reapable
      : REAPABLE_CLAIM_ANYWHERE_PATTERN.exec(trimmed)?.[1];
  const normalized = status?.toLowerCase();
  return normalized !== undefined && normalized in STANDALONE_REAPABLE_STATUSES
    ? (normalized as ReapabilityClaimStatus)
    : undefined;
}

/** The single shared home for "is this agent currently reapable": the most
 *  recent qualifying `{"reapable":"<status>"}` claim among an agent's recent
 *  assistant messages, not necessarily its literal last one. A polite
 *  trailing message (a sign-off, an acknowledgment) does not erase a still-
 *  valid claim — but a trailing message carrying its own explicit signal
 *  (a fresh `{"blocked":true}`, a retired reapable marker) takes precedence
 *  and stops the scan, so a claim can never be resurrected past an agent
 *  that has since said it is blocked or otherwise moved on. */
export function findLatestQualifyingReapabilityClaim(
  output: string,
): ReapabilityClaimStatus | undefined {
  const blocks = assistantMessageBlocks(output);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const claim = readReapabilityClaimStatus(block);
    if (claim !== undefined) {
      return claim;
    }
    if (classifyLastMessageTags(block).kind !== 'unmarked') {
      return undefined;
    }
  }
  return undefined;
}

/** `classifyLastMessageTags`, widened to decide the `reapable`/`reapable-failed`
 *  kinds from {@link findLatestQualifyingReapabilityClaim} instead of the
 *  strict last message alone. Blocked/busy/retired-marker/unmarked detection
 *  is unchanged and still reads only the last assistant message — Finding 3
 *  is scoped to the reapability claim, not the blocked marker. */
export function classifyReapabilityAwareLastMessageTags(
  output: string,
): LastMessageTagState {
  const claim = findLatestQualifyingReapabilityClaim(output);
  if (claim !== undefined) {
    const marker = STANDALONE_REAPABLE_STATUSES[claim];
    if (marker !== undefined) {
      return marker === REAPABLE_MARKER_FAIL
        ? { kind: 'reapable-failed' }
        : { kind: 'reapable' };
    }
  }
  return classifyLastMessageTags(lastMessageBlock(output));
}
