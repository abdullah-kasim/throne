import type { StoredSection } from "@contract/where-i-stand.ts";
import { useDeferredValue } from "react";
import { ArchiveControl } from "@/features/where-i-stand/archive-control";
import { ArchivedSectionsSpoiler, ArchivedSpoiler } from "@/features/where-i-stand/archived-spoiler";
import { AGE_GROUPS_IN_ORDER, ageGroupOf } from "@/features/where-i-stand/describe-times";
import { InlineMarkdown, MarkdownText } from "@/features/where-i-stand/markdown-text";
import { entryIsEpic, type PageTab } from "@/features/where-i-stand/page-tabs";
import { isNeedsYouEntry, NEEDS_YOU_HEADING, type PageEntry, type PageSection } from "@/features/where-i-stand/read-page";
import { RowAge } from "@/features/where-i-stand/row-age";
import { ThroneAndDotfilesSpoiler } from "@/features/where-i-stand/throne-and-dotfiles-spoiler";
import { entryIsThroneOrDotfilesWork } from "@/features/where-i-stand/work-rows";

const ENTRIES_FILLING_THE_FIRST_SCREEN = 8;
const ENTRIES_MOVED_WORDS = "Moved to Throne and dotfiles, at the foot of this tab.";

interface Shown {
  readonly now: number;
  readonly announce: (message: string) => void;
}

function entryMovesToTheSpoiler(entry: PageEntry): boolean {
  return !entryIsEpic(entry) && entryIsThroneOrDotfilesWork(entry);
}

function isNeedsYouSection({ heading }: PageSection): boolean {
  return heading === NEEDS_YOU_HEADING;
}

function EntryControls({ entry, now, announce }: { entry: PageEntry } & Shown) {
  return (
    <div className="unit-controls">
      <RowAge row={entry.row} now={now} />
      <ArchiveControl name={entry.identity} what="row" path={`rows/${entry.id}`} announce={announce} />
    </div>
  );
}

function EntryShown({ entry, now, announce }: { entry: PageEntry } & Shown) {
  if (entry.row.kind === "event") {
    return (
      <li className="event">
        <InlineMarkdown markdown={entry.row.text} />
        <EntryControls entry={entry} now={now} announce={announce} />
      </li>
    );
  }
  return (
    <div className="entry">
      <MarkdownText markdown={entry.markdown} />
      <EntryControls entry={entry} now={now} announce={announce} />
    </div>
  );
}

function EntriesShown({ entries, now, announce }: { entries: readonly PageEntry[] } & Shown) {
  const events = entries.filter(({ row }) => row.kind === "event");
  const others = entries.filter(({ row }) => row.kind !== "event");
  return (
    <>
      {events.length > 0 && (
        <ul className="events">
          {events.map((entry) => (
            <EntryShown key={entry.id} entry={entry} now={now} announce={announce} />
          ))}
        </ul>
      )}
      {others.map((entry) => (
        <EntryShown key={entry.id} entry={entry} now={now} announce={announce} />
      ))}
    </>
  );
}

function EntriesByAge({ entries, now, announce }: { entries: readonly PageEntry[] } & Shown) {
  const groups = AGE_GROUPS_IN_ORDER.map((group) => ({ group, entries: entries.filter(({ row }) => ageGroupOf(row.changedAt, now) === group) })).filter((group) => group.entries.length > 0);
  const groupedOrder = groups.flatMap((group) => group.entries);
  const groupingKeepsTheOrder = groupedOrder.every((entry, index) => entry === entries[index]);
  if (groups.length < 2 || !groupingKeepsTheOrder) return <EntriesShown entries={entries} now={now} announce={announce} />;
  return groups.map(({ group, entries: entriesOfGroup }) => (
    <div key={group} className="age-group">
      <p className="age-divider">{group}</p>
      <EntriesShown entries={entriesOfGroup} now={now} announce={announce} />
    </div>
  ));
}

function SectionHeading({ section }: { section: PageSection }) {
  return section.depth === 1 ? <h2>{section.heading}</h2> : <h3>{section.heading}</h3>;
}

function SectionShown({ section, now, announce }: { section: PageSection } & Shown) {
  const entriesInPlace = section.entries.filter((entry) => !entryMovesToTheSpoiler(entry));
  const entriesReady = useDeferredValue(entriesInPlace.length, Math.min(entriesInPlace.length, ENTRIES_FILLING_THE_FIRST_SCREEN));
  const everyNeedsYouEntryMoved = isNeedsYouSection(section) && section.entries.length > 0 && entriesInPlace.length === 0;
  const className = [section.depth > 1 ? "subsection" : "", isNeedsYouSection(section) ? "needs-you" : ""].filter(Boolean).join(" ");
  return (
    <section className={className || undefined}>
      <div className="section-heading">
        <SectionHeading section={section} />
        <ArchiveControl name={section.heading} what="section" path={`sections/${section.id}`} announce={announce} />
      </div>
      {everyNeedsYouEntryMoved && <p>{ENTRIES_MOVED_WORDS}</p>}
      <EntriesByAge entries={entriesInPlace.slice(0, entriesReady)} now={now} announce={announce} />
      {section.subsections.map((subsection) => (
        <SectionShown key={subsection.id} section={subsection} now={now} announce={announce} />
      ))}
      <ArchivedSpoiler section={section} now={now} announce={announce} />
    </section>
  );
}

function everyEntryOf(section: PageSection): PageEntry[] {
  return [...section.entries, ...section.subsections.flatMap(everyEntryOf)];
}

interface ReadOnlySectionsProps extends Shown {
  readonly tab: PageTab | undefined;
  readonly sections: readonly PageSection[];
  readonly archivedSections: readonly StoredSection[];
}

export function ReadOnlySections({ tab, sections, archivedSections, now, announce }: ReadOnlySectionsProps) {
  const sectionsOfTab = sections.filter(({ tabId }) => tabId === tab?.id);
  const movedEntries = sectionsOfTab.flatMap(everyEntryOf).filter(entryMovesToTheSpoiler);
  const movedEntriesReady = useDeferredValue(movedEntries.length, 0);
  return (
    <>
      {[...sectionsOfTab.filter(isNeedsYouSection), ...sectionsOfTab.filter((section) => !isNeedsYouSection(section))].map((section) => (
        <SectionShown key={section.id} section={section} now={now} announce={announce} />
      ))}
      {movedEntries.length > 0 && (
        <section>
          <ThroneAndDotfilesSpoiler needsYouFlags={movedEntries.map(isNeedsYouEntry)} everyRowIsKnown>
            {movedEntries.slice(0, movedEntriesReady).map((entry) => (
              <div key={entry.id}>
                <p>Section: {entry.sectionHeading}</p>
                <EntryShown entry={entry} now={now} announce={announce} />
              </div>
            ))}
          </ThroneAndDotfilesSpoiler>
        </section>
      )}
      <ArchivedSectionsSpoiler sections={archivedSections.filter(({ tabId }) => tabId === tab?.id)} now={now} announce={announce} />
    </>
  );
}
