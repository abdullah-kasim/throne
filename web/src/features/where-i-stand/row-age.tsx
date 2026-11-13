import type { StoredRow } from "@contract/where-i-stand.ts";
import { useEffect, useState } from "react";
import { deletionMonthOf, describeRowAge, describeTime } from "@/features/where-i-stand/describe-times";

const AGES_ADVANCE_EVERY_MILLISECONDS = 30000;
const SAME_MOMENT_MILLISECONDS = 60000;

type DatedItem = Pick<StoredRow, "writtenAt" | "changedAt" | "archivedAt" | "writtenDateIsEstimate">;

export function useNow(serverNow: string | undefined): number {
  const [browserNow, setBrowserNow] = useState(() => Date.now());
  const [serverAhead, setServerAhead] = useState<number | undefined>(undefined);
  if (serverAhead === undefined && serverNow !== undefined) setServerAhead(new Date(serverNow).getTime() - browserNow);
  useEffect(() => {
    const timer = setInterval(() => setBrowserNow(Date.now()), AGES_ADVANCE_EVERY_MILLISECONDS);
    return () => clearInterval(timer);
  }, []);
  return browserNow + (serverAhead ?? 0);
}

function exactly(time: string): string {
  return describeTime(new Date(time));
}

function wasChangedAfterWriting(row: DatedItem): boolean {
  return new Date(row.changedAt).getTime() - new Date(row.writtenAt).getTime() >= SAME_MOMENT_MILLISECONDS;
}

function ageWords(row: DatedItem, now: number): { words: string; exactWords: string } {
  if (row.archivedAt !== null) {
    return { words: `archived ${describeRowAge(row.archivedAt, now)}, deleted in ${deletionMonthOf(row.archivedAt)}`, exactWords: `archived ${exactly(row.archivedAt)}` };
  }
  const about = row.writtenDateIsEstimate ? "about " : "";
  const written = `written ${about}${describeRowAge(row.writtenAt, now)}`;
  const writtenExactly = `written ${about}${exactly(row.writtenAt)}`;
  if (!wasChangedAfterWriting(row)) return { words: written, exactWords: writtenExactly };
  return { words: `${written}, changed ${describeRowAge(row.changedAt, now)}`, exactWords: `${writtenExactly}, changed ${exactly(row.changedAt)}` };
}

export function RowAge({ row, now }: { row: DatedItem; now: number }) {
  const [isExactShown, setIsExactShown] = useState(false);
  const { words, exactWords } = ageWords(row, now);
  return (
    <span className="row-age">
      <button type="button" title={exactWords} aria-label={`${words} (${exactWords})`} aria-expanded={isExactShown} onClick={() => setIsExactShown(!isExactShown)}>
        {words}
      </button>
      {isExactShown && <span className="row-age-exact">{exactWords}</span>}
    </span>
  );
}
