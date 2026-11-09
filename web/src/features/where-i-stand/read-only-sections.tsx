import { useDeferredValue } from "react";
import { MarkdownText } from "@/features/where-i-stand/markdown-text";
import { entryIsEpic, tabNameOfSection, type TabName } from "@/features/where-i-stand/page-tabs";
import { isNeedsYouEntry, NEEDS_YOU_HEADING, type PageEntry, type PageSection } from "@/features/where-i-stand/read-page";
import { ThroneAndDotfilesSpoiler } from "@/features/where-i-stand/throne-and-dotfiles-spoiler";
import { entryIsThroneOrDotfilesWork } from "@/features/where-i-stand/work-rows";

const ENTRIES_FILLING_THE_FIRST_SCREEN = 8;
const ENTRIES_MOVED_WORDS = "Moved to Throne and dotfiles, at the foot of this tab.";

function entryMovesToTheSpoiler(entry: PageEntry): boolean {
  return !entryIsEpic(entry) && entryIsThroneOrDotfilesWork(entry);
}

function isNeedsYouSection({ heading }: PageSection): boolean {
  return heading === NEEDS_YOU_HEADING;
}

function SectionShown({ section }: { section: PageSection }) {
  const entriesInPlace = section.entries.filter((entry) => !entryMovesToTheSpoiler(entry));
  const entriesReady = useDeferredValue(entriesInPlace.length, Math.min(entriesInPlace.length, ENTRIES_FILLING_THE_FIRST_SCREEN));
  const everyNeedsYouEntryMoved = isNeedsYouSection(section) && section.entries.length > 0 && entriesInPlace.length === 0;
  return (
    <section className={isNeedsYouSection(section) ? "needs-you" : undefined}>
      <MarkdownText markdown={section.opening} />
      {everyNeedsYouEntryMoved && <p>{ENTRIES_MOVED_WORDS}</p>}
      {entriesInPlace.slice(0, entriesReady).map((entry, index) => (
        <MarkdownText key={index} markdown={entry.markdown} />
      ))}
    </section>
  );
}

export function ReadOnlySections({ tabName, sections }: { tabName: TabName; sections: readonly PageSection[] }) {
  const sectionsOfTab = sections.filter(({ heading }) => tabNameOfSection(heading) === tabName);
  const movedEntries = sectionsOfTab.flatMap(({ entries }) => entries.filter(entryMovesToTheSpoiler));
  const movedEntriesReady = useDeferredValue(movedEntries.length, 0);
  return (
    <>
      {[...sectionsOfTab.filter(isNeedsYouSection), ...sectionsOfTab.filter((section) => !isNeedsYouSection(section))].map((section, index) => (
        <SectionShown key={index} section={section} />
      ))}
      {movedEntries.length > 0 && (
        <section>
          <ThroneAndDotfilesSpoiler needsYouFlags={movedEntries.map(isNeedsYouEntry)} everyRowIsKnown>
            {movedEntries.slice(0, movedEntriesReady).map((entry, index) => (
              <div key={index}>
                <p>Section: {entry.sectionHeading}</p>
                <MarkdownText markdown={entry.markdown} />
              </div>
            ))}
          </ThroneAndDotfilesSpoiler>
        </section>
      )}
    </>
  );
}
