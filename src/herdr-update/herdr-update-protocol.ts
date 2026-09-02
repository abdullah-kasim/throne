import { THRONE_HERDR_PROTOCOL } from '../herdr/herdr-client.ts';

export interface HerdrUpdateProtocolComparison {
  readonly pinnedProtocol: string;
  readonly liveProtocol: string | null;
  readonly matches: boolean;
}

/** Compares the isolated session's live-reported protocol against the pinned
 *  `THRONE_HERDR_PROTOCOL` constant. The comparison result is the deliverable;
 *  this never edits the constant — a mismatch is acted on by a future
 *  real-upgrade slice, not here. */
export function compareLiveProtocolToPinned(
  liveProtocol: string | null,
): HerdrUpdateProtocolComparison {
  return {
    pinnedProtocol: THRONE_HERDR_PROTOCOL,
    liveProtocol,
    matches: liveProtocol === THRONE_HERDR_PROTOCOL,
  };
}
