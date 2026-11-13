import type { StoredSection } from "@contract/where-i-stand.ts";
import { ArchivedRows } from "@/features/where-i-stand/archived-spoiler";
import { RestoreControl } from "@/features/where-i-stand/archive-control";
import { selectedTabButton } from "@/features/where-i-stand/page-tabs";
import type { PageSection } from "@/features/where-i-stand/read-page";
import { RowAge } from "@/features/where-i-stand/row-age";

export const EMPTY_ARCHIVE_WORDS = "Nothing has been archived yet.";
const ARCHIVE_OPENING_WORDS = "Archived rows and sections, by section. Read only; Restore puts one back on the page.";

interface ArchiveTabProps {
  readonly sections: readonly PageSection[];
  readonly archivedSections: readonly StoredSection[];
  readonly now: number;
  readonly announce: (message: string) => void;
}

function sectionsWithArchivedRows(sections: readonly PageSection[]): PageSection[] {
  return sections.flatMap((section) => [...(section.archivedRowCount > 0 ? [section] : []), ...sectionsWithArchivedRows(section.subsections)]);
}

export function ArchiveTab({ sections, archivedSections, now, announce: announceOnThePage }: ArchiveTabProps) {
  const announce = (message: string) => {
    announceOnThePage(message);
    if (document.activeElement === document.body) selectedTabButton()?.focus();
  };
  const archivedRowSections = sectionsWithArchivedRows(sections);
  if (archivedRowSections.length === 0 && archivedSections.length === 0) return <p>{EMPTY_ARCHIVE_WORDS}</p>;
  return (
    <>
      <p>{ARCHIVE_OPENING_WORDS}</p>
      {archivedRowSections.map((section) => (
        <section key={section.id}>
          <h2>{section.heading}</h2>
          <ArchivedRows section={section} now={now} announce={announce} trigger={selectedTabButton} />
        </section>
      ))}
      {archivedSections.length > 0 && (
        <section>
          <h2>Archived sections</h2>
          {archivedSections.map((section) => (
            <div key={section.id} className="archived-row unit-controls">
              <span>{section.name}</span>
              <RowAge row={{ ...section, writtenDateIsEstimate: false }} now={now} />
              <RestoreControl name={section.name} path={`sections/${section.id}`} announce={announce} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}
