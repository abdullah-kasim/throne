import type { LastMessageTagState } from './idle-pane-tag-classification.ts';

export interface BlockedMarkerLedger {
  readBlockedMarker: (
    name: string,
  ) => Promise<
    | {
        blockedAt: string;
        reason?: string;
        origin?: 'agent' | 'regent';
        blockedBy?: readonly string[];
      }
    | null
  >;
  writeBlockedMarker: (name: string, blockedBy?: readonly string[]) => Promise<void>;
  clearBlockedMarker: (name: string) => Promise<void>;
}

/**
 * The durable ledger record is authoritative over observer inference, while
 * the agent's own latest declaration remains authoritative over its earlier
 * declaration. A later ordinary or reapable turn retires the marker. Pane
 * chrome and read failures cannot retire it. A marker authored by the Regent
 * about an agent that cannot speak for itself (origin 'regent') is retired
 * only by that agent's own later ordinary or reapable turn, never by an
 * unmarked pane, since an unmarked pane is not an agent declaration.
 *
 * The persisted `blockedBy` list is written once, at first observation of
 * the block, from the agent's own pane declaration, and is returned
 * unchanged from the ledger on every later "still blocked" sweep -- never
 * re-derived from a fresh pane read, matching every other durable field on
 * this record.
 */
export async function resolveBlockedTag(
  name: string,
  paneTag: () => Promise<LastMessageTagState>,
  ledger: BlockedMarkerLedger,
): Promise<LastMessageTagState> {
  const marker = await ledger.readBlockedMarker(name);
  const tag = await paneTag();
  if (marker !== null) {
    const clearingKinds =
      marker.origin === 'regent'
        ? tag.kind === 'reapable' || tag.kind === 'reapable-failed'
        : tag.kind === 'unmarked' || tag.kind === 'reapable' || tag.kind === 'reapable-failed';
    if (clearingKinds) {
      await ledger.clearBlockedMarker(name);
      return tag;
    }
    return { kind: 'blocked', blockedBy: marker.blockedBy ?? [] };
  }
  if (tag.kind === 'blocked') {
    await ledger.writeBlockedMarker(name, tag.blockedBy);
  }
  return tag;
}
