import type { StoredSection } from "@contract/where-i-stand.ts";
import { useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RestoreControl } from "@/features/where-i-stand/archive-control";
import { useFocusKeptWhenItsControlLeaves } from "@/features/where-i-stand/focus-kept";
import { InlineMarkdown, MarkdownText } from "@/features/where-i-stand/markdown-text";
import { useArchivedRows } from "@/features/where-i-stand/page-queries";
import { entryOfRow, type PageSection } from "@/features/where-i-stand/read-page";
import { RowAge } from "@/features/where-i-stand/row-age";

interface ArchivedRowsProps {
  readonly section: PageSection;
  readonly now: number;
  readonly announce: (message: string) => void;
}

export function ArchivedRows({ section, now, announce, trigger }: ArchivedRowsProps & { readonly trigger: () => HTMLElement | null }) {
  const archived = useArchivedRows(section.id, true);
  useFocusKeptWhenItsControlLeaves(trigger);
  if (archived.isError) return <p className="problem">Could not fetch the archived rows.</p>;
  if (archived.data === undefined) return <p>Fetching the archived rows.</p>;
  const shown = archived.data.rows.map((row) => ({ row, entry: entryOfRow(row, section.heading, section.depth) }));
  const controls = ({ row, entry }: (typeof shown)[number]) => (
    <div className="unit-controls">
      <RowAge row={row} now={now} />
      <RestoreControl name={entry.identity} path={`rows/${row.id}`} announce={announce} />
    </div>
  );
  const events = shown.filter(({ row }) => row.kind === "event");
  return (
    <>
      {events.length > 0 && (
        <ul className="events">
          {events.map((each) => (
            <li key={each.row.id} className="event archived-row">
              <span className="archived-text">
                <InlineMarkdown markdown={each.row.text} />
              </span>
              {controls(each)}
            </li>
          ))}
        </ul>
      )}
      {shown
        .filter(({ row }) => row.kind !== "event")
        .map((each) => (
          <div key={each.row.id} className="archived-row">
            <MarkdownText markdown={each.entry.markdown} />
            {controls(each)}
          </div>
        ))}
    </>
  );
}

export function ArchivedSpoiler({ section, now, announce }: ArchivedRowsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (section.archivedRowCount === 0) {
    if (isOpen) setIsOpen(false);
    return null;
  }
  return (
    <Collapsible className="archived" open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger ref={trigger} className="archived-trigger">{`Archived (${section.archivedRowCount})`}</CollapsibleTrigger>
      <CollapsibleContent>{isOpen && <ArchivedRows section={section} now={now} announce={announce} trigger={() => trigger.current} />}</CollapsibleContent>
    </Collapsible>
  );
}

interface ArchivedSectionsProps {
  readonly sections: readonly StoredSection[];
  readonly now: number;
  readonly announce: (message: string) => void;
}

export function ArchivedSectionsSpoiler({ sections, now, announce }: ArchivedSectionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  if (sections.length === 0) return null;
  return (
    <Collapsible className="archived" open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="archived-trigger">{`Archived sections (${sections.length})`}</CollapsibleTrigger>
      <CollapsibleContent>
        {sections.map((section) => (
          <div key={section.id} className="archived-row unit-controls">
            <span>{section.name}</span>
            <RowAge row={{ ...section, writtenDateIsEstimate: false }} now={now} />
            <RestoreControl name={section.name} path={`sections/${section.id}`} announce={announce} />
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
