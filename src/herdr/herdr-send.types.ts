import type { OmpDeliveryOutcome } from "./omp-delivery-client.ts";
import type { stagePayload } from '../send-agent/payload-transport.ts';
import type { RecipientPaneLockService } from '../shared-policy/recipient-pane-lock.service.ts';
import type { HerdrAgent } from './herdr-inventory.service.ts';
import type { KeyedSubmissionWindowStore } from './keyed-submission-token.ts';
import type { getPaneProcessInfo } from './herdr-runtime.service.ts';
import type {
  pressEnter,
  pressPaneKey,
  sendText,
} from './herdr-client.ts';

export const HERDR_PROMPT_SETTLED_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * How long the confirm-written poll (`pollForVisibleEffect`, step 3 of the
 * submit handshake) may wait for a just-written payload to render before
 * giving up. A distinct bound from `PRESS_ENTER_UNTIL_EMPTY_BOUNDS.timeoutMilliseconds`
 * (step 5's press-and-observe deadline) even though both are 45s today — the
 * two guard different steps and may diverge independently.
 */
export const COMPOSER_VISIBILITY_TIMEOUT_MS = 45_000;
export const COMPOSER_VISIBILITY_POLL_MS = 100;

export const RESIDENT_COMPOSER_TIMEOUT_MS = 60 * 60 * 1_000;
export const RESIDENT_COMPOSER_POLL_MS = 1_000;
export const COMPOSER_RECOGNITION_TIMEOUT_MS = 45_000;

/**
 * How long a resident draft may block a delivery before this court presses
 * Enter to submit it FOR the human who left it there (DWR, Lord's order,
 * 2026-08-14 verbatim: "I think each message needs a max wait time i.e. if
 * the text box doesnt clear at this time, force send" / "15 mins is
 * hopefully enough"). This is his declared tolerance, not a measured or
 * derived bound — recorded as a preference, not dressed up as arithmetic.
 * Submitting a resident DRAFT is consent-submission, never a clobber: the
 * human's own text is sent (not destroyed), the box clears, this court's
 * message then delivers, and the human recovers their text with Up. This
 * must NEVER apply to `state === "modal"` (an open interactive menu) —
 * pressing Enter there SELECTS AN OPTION on the human's or another agent's
 * behalf, which is a decision, not plumbing (see `alpha-bsy-busy-not-draft`,
 * 52adacd, and the Regent's ruling carried into this campaign).
 */
export const RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS = 15 * 60 * 1_000;

/** How long the throne waits for the omp extension to ack a delivery. Matched
 *  to the resident-draft wait every other harness gets: the extension holds a
 *  request exactly as long as a human keeps a draft open, so anything shorter
 *  would report not-sent on a recipient who is merely mid-sentence. */
export const OMP_DELIVERY_TIMEOUT_MS = RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS;

export class SubmitNotSentError extends Error {
  readonly name = 'SubmitNotSentError';
  readonly recipientName: string;

  constructor(recipientName: string, cause: unknown) {
    super(
      `send-agent: failed before delivering text to "${recipientName}": ` +
        (cause instanceof Error ? cause.message : String(cause)) +
        ' — nothing was written to the pane; the exact same call is retry-safe.',
      { cause },
    );
    this.recipientName = recipientName;
  }
}

/**
 * A composer has exactly two states: `empty` (nothing sent) or `filled`
 * (sent). A third "indeterminate" verdict is a category error — it encodes
 * OUR uncertainty about the observation as if it were THEIR state. When an
 * observation can't tell empty from filled, the answer is to look again, not
 * to invent a third value; when looks run out, the classifier assumes
 * `filled` (never re-presses into a possibly-already-submitted composer).
 * This error is that assume-filled verdict: measured cost of the opposite
 * default (assuming empty and resending) was 3 lost campaign briefs, 4 lost
 * corrections, ~8 hand-recovered panes, and 3.5 hours of watchdog silence,
 * against zero observed duplicates from assuming filled instead.
 */
export class SubmitAssumedFilledError extends Error {
  readonly name = 'SubmitAssumedFilledError';
  readonly recipientName: string;
  readonly reason: string;

  constructor(recipientName: string, reason: string, cause?: unknown) {
    super(
      `send-agent: "${recipientName}" is assumed filled after an unreadable ` +
        `submit observation (${reason}). Text may already be resident or ` +
        `pending — do NOT resend. Use send-agent ${recipientName} --enter-only ` +
        `only if the same resident representation is still visible in the ` +
        `active composer.`,
      cause === undefined ? undefined : { cause },
    );
    this.recipientName = recipientName;
    this.reason = reason;
  }
}

export interface SubmitToAgentOptions {
  /** Coalesce concurrent callers for one logical recipient window. */
  key?: string;
  /** Explicit emergency path for callers that intentionally bypass locks and composer waits. */
  forceImmediate?: boolean;
  textOnly?: boolean;
  skipText?: boolean;
  omitSenderAttribution?: boolean;
  forceFileBackedDelivery?: boolean;
  disableFileBackedDelivery?: boolean;
  /**
   * When the pre-lock resident-draft wait (bounded by
   * `composerWaitMilliseconds` / `RESIDENT_DRAFT_FORCE_SUBMIT_WAIT_MS`)
   * expires while a draft is STILL resident, press Enter once to submit it
   * (consent-submission, never a clobber — the human's text is sent, not
   * destroyed) rather than give up. Defaults true for every caller EXCEPT
   * `send-agent-legacy`, which sets it false: DWR, Regent ruling 2026-08-14
   * — "a rescue tool that waits 15 minutes is not a rescue tool" — the
   * rescue path exists for when the queue/backend is itself broken, and an
   * operator reaching for it wants an immediate, honest "the recipient's
   * box is occupied" rather than the rescue tool silently submitting
   * someone else's draft while jamming an emergency message through. Never
   * applies to `state === "modal"` regardless of this flag.
   */
  forceSubmitResidentDraftOnTimeout?: boolean;
  composerWaitMilliseconds?: number;
  waitForStartupQuiescence?: boolean;
  onDeliveredWhileLocked?: () => Promise<void>;
}

export interface SubmitToAgentDeps {
  sendText: typeof sendText;
  /** Hands a payload to the throne's omp extension and waits for its ack.
   *  Injected so tests never touch a real ~/.omp or a real filesystem
   *  handshake. */
  /** `recipientPaneId` is required: every omp instance polls one shared
   *  directory, so an unaddressed request is claimed by whichever instance is
   *  idle first rather than by the intended recipient. */
  deliverToOmp: (
    text: string,
    timeoutMs: number,
    recipientPaneId: string,
  ) => Promise<OmpDeliveryOutcome>;
  pressEnter: typeof pressEnter;
  pressPaneKey: typeof pressPaneKey;
  getPaneProcessInfo: typeof getPaneProcessInfo;
  readVisibleAgentAnsi: (target: string) => Promise<string>;
  readRecentAgentAnsi: (target: string) => Promise<string>;
  readVisibleCodexAgentAnsi?: (target: string) => Promise<string>;
  readRecentCodexAgentAnsi?: (target: string) => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  refreshRecipientIdentity: (
    recipientName: string,
    initial: HerdrAgent,
  ) => Promise<HerdrAgent>;
  withRecipientPaneLock: RecipientPaneLockService['withRecipientPaneLock'];
  stagePayload: typeof stagePayload;
  fileBackedPayloadsEnabled?: boolean;
  keyedSubmissionWindowStore?: KeyedSubmissionWindowStore;
  /**
   * Best-effort forensic capture, called with the last screen observed right
   * before `waitForRecognizedComposer` gives up on a recipient as
   * `unavailable`. Optional so every existing test-fixture deps object keeps
   * compiling unchanged; omitting it just means no diagnostic is written.
   * See `herdr-composer-diagnostic-capture.ts` for why this exists.
   */
  captureComposerDiagnostic?: (
    recipientName: string,
    visibleAnsi: string,
  ) => Promise<string | undefined>;
}

export interface PressEnterUntilEmptyTextboxDeps {
  pressEnter: typeof pressEnter;
  getPaneProcessInfo: typeof getPaneProcessInfo;
  readVisibleAgentAnsi: (target: string) => Promise<string>;
  readVisibleCodexAgentAnsi?: (target: string) => Promise<string>;
  readRecentAgentAnsi: (target: string) => Promise<string>;
  readRecentCodexAgentAnsi?: (target: string) => Promise<string>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

/**
 * One recipient's answer to "has this composer provably taken the message?",
 * read from one observation.
 *
 * `unconfirmed` keeps the transaction going; `mayPressAgain` is the harness's
 * veto on another key while the composer remains nonempty or a read failed.
 * `observedText` carries the composer's current content when the harness can
 * read it (a resident draft), so the caller can decide whether that content
 * is still the payload it is submitting — the clearance factory only reports
 * what it saw, never that identity decision. Canonical empty returns
 * `confirmed` immediately. `observationError` records a screen read that
 * failed, so the transaction can surface that error instead of a press-count
 * reason when its bound expires.
 */
export type ComposerClearanceObservation =
  | { readonly clearance: 'confirmed' }
  | {
      readonly clearance: 'unconfirmed';
      readonly mayPressAgain: boolean;
      readonly observedText?: string;
      readonly observationError?: unknown;
    }
  | { readonly clearance: 'refused'; readonly reason: string };

/**
 * The per-harness half of a submission: what counts as clearance, and how it is
 * observed. The transaction owns the press cadence, the bounds and the honest
 * assume-filled failure; it never decides clearance itself.
 */
export interface ComposerClearanceContract {
  /** Names what clearance was never reached, for the assume-filled reason. */
  readonly unmetClearanceDescription: string;
  observe(
    target: HerdrAgent,
    deps: PressEnterUntilEmptyTextboxDeps,
  ): Promise<ComposerClearanceObservation>;
}

export interface PressEnterUntilEmptyTextboxBounds {
  timeoutMilliseconds: number;
  pollMilliseconds: number;
  pressSpacingMilliseconds: number;
  maxPresses: number;
}
