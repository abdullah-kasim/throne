import { useRef, useState, type KeyboardEvent } from "react";
import { useLocation } from "react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AddEpicForm } from "@/features/where-i-stand/add-epic-form";
import { epicNameAmong, headingLineOf, notesOf } from "@/features/where-i-stand/epic-markdown";
import { MarkdownText, UnsavedText } from "@/features/where-i-stand/markdown-text";
import { selectedTabButton, selectedTabNameOf, TabName } from "@/features/where-i-stand/page-tabs";
import type { PageEntry, PageSection } from "@/features/where-i-stand/read-page";
import { draftIsUnsaved, holdsUnsavedWords, type EpicEditors } from "@/features/where-i-stand/use-epic-editors";

export function isSaveShortcut(event: { metaKey: boolean; ctrlKey: boolean; key: string }): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

function RemoveEpicControl({ epic, name, editors, isDisabled }: { epic: PageEntry; name: string; editors: EpicEditors; isDisabled: boolean }) {
  const epicsTabIsShowing = selectedTabNameOf(useLocation().hash) === TabName.Epics;
  const [isAsking, setIsAsking] = useState(false);
  if (isAsking && !epicsTabIsShowing) setIsAsking(false);

  function focusTheShownTabInsteadOfAHiddenButton(event: Event) {
    if (epicsTabIsShowing) return;
    event.preventDefault();
    selectedTabButton()?.focus();
  }

  function removeIfStillAsking() {
    if (isAsking) void editors.removeEpic(epic);
  }

  return (
    <AlertDialog open={isAsking} onOpenChange={setIsAsking}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`Remove ${name} epic`} disabled={isDisabled}>
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="[overflow-wrap:anywhere] data-[state=closed]:animate-none!" onCloseAutoFocus={focusTheShownTabInsteadOfAHiddenButton}>
        <AlertDialogHeader>
          <AlertDialogTitle>{`Remove epic '${name}'?`}</AlertDialogTitle>
          <AlertDialogDescription>This takes the epic and its notes off the page.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep epic</AlertDialogCancel>
          <AlertDialogAction onClick={removeIfStillAsking}>Remove epic</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function toggleWords(isOpen: boolean, wordsWouldBeLost: boolean): { words: string; labelStart: string } {
  if (wordsWouldBeLost) return { words: "Discard changes", labelStart: "Discard changes to" };
  return isOpen ? { words: "Close", labelStart: "Close" } : { words: "Edit", labelStart: "Edit" };
}

function EpicBlock({ epic, editors }: { epic: PageEntry; editors: EpicEditors }) {
  const state = editors.stateOf(epic);
  const name = epicNameAmong(epic, editors.epics);
  const label = `${name} epic`;
  const wordsWouldBeLost = holdsUnsavedWords(state);
  const { words, labelStart } = toggleWords(state.isOpen, wordsWouldBeLost);
  const notesBox = useRef<HTMLTextAreaElement>(null);
  const [editorWasOpenOnArrival, setEditorWasOpenOnArrival] = useState(state.isOpen);
  if (editorWasOpenOnArrival && !state.isOpen) setEditorWasOpenOnArrival(false);

  function saveNotes() {
    notesBox.current?.focus();
    void editors.saveEpic(epic);
  }

  function actOnEditorKeys(event: KeyboardEvent<HTMLDivElement>) {
    const pressedInsideTheEpic = event.currentTarget.contains(event.target as Node);
    if (!state.isOpen || !pressedInsideTheEpic) return;
    if (isSaveShortcut(event)) saveNotes();
    if (event.key === "Escape" && !wordsWouldBeLost) editors.closeEditorOntoItsToggle(epic.identity);
  }

  return (
    <div className="epic" onKeyDown={actOnEditorKeys}>
      <MarkdownText markdown={state.isOpen ? headingLineOf(epic.markdown) : epic.markdown} />
      {state.isOpen && (
        <Textarea
          ref={notesBox}
          autoFocus={!editorWasOpenOnArrival}
          aria-label={label}
          placeholder="Add notes"
          readOnly={state.isBeingRemoved}
          value={state.draft?.text ?? notesOf(epic.markdown)}
          onChange={(event) => editors.typeNotes(epic, event.target.value)}
        />
      )}
      <div className="unit-controls">
        {draftIsUnsaved(state) && (
          <Button type="button" size="sm" aria-label={`Save ${label}`} onClick={saveNotes}>
            Save
          </Button>
        )}
        <Button
          ref={(button) => editors.rememberToggleButton(epic.identity, button)}
          type="button"
          variant="outline"
          size="sm"
          aria-label={`${labelStart} ${label}`}
          disabled={state.isSavingNotes}
          onClick={() => (state.isOpen ? editors.closeEditor(epic.identity) : editors.openEditor(epic))}
        >
          {words}
        </Button>
        <RemoveEpicControl epic={epic} name={name} editors={editors} isDisabled={state.isSavingNotes} />
        <span className={state.isProblem ? "unit-status problem" : "unit-status"}>{state.status}</span>
      </div>
      {state.unsavedText !== "" && <UnsavedText text={state.unsavedText} />}
    </div>
  );
}

interface EpicsTabProps {
  readonly section: PageSection | undefined;
  readonly editors: EpicEditors;
  readonly announce: (message: string) => void;
}

export function EpicsTab({ section, editors, announce }: EpicsTabProps) {
  return (
    <>
      <AddEpicForm announce={announce} />
      {section !== undefined && (
        <section>
          <MarkdownText markdown={section.opening} />
          {editors.epics.map((epic) => (
            <EpicBlock key={epic.identity} epic={epic} editors={editors} />
          ))}
        </section>
      )}
    </>
  );
}
