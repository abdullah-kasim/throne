import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addEpicRefusal, notesLinesOf } from "@/features/where-i-stand/epic-markdown";
import { refreshThePage, SAVE_ALREADY_ON_ITS_WAY_WORDS, shownPage, THE_LORD, writeToTheStore } from "@/features/where-i-stand/page-queries";
import { readPage, type PageSection } from "@/features/where-i-stand/read-page";

const REFUSED = "refused";
const SAVED = "done";
const SAVED_WORDS = "Saved.";
const TEXT_LEFT_UNSAVED_WORDS = "Saved what was sent. The text now in this form is not saved.";
const TEXT_NOT_SENT_WORDS = "The text now in this form was not sent.";
const NO_STATUS = { message: "", isProblem: false };

interface EpicText {
  readonly title: string;
  readonly notes: string;
}

interface AddAnswer {
  readonly outcome: string;
  readonly message: string;
}

function withoutTextJustSaved(current: string, savedText: string): string {
  return current.trim() === savedText ? "" : current;
}

function textBesidesWhatWasSent(form: EpicText, sent: EpicText): EpicText {
  return { title: withoutTextJustSaved(form.title, sent.title), notes: withoutTextJustSaved(form.notes, sent.notes) };
}

function statusAfterAnswer({ outcome, message }: AddAnswer, sent: EpicText, form: EpicText) {
  const { title, notes } = textBesidesWhatWasSent(form, sent);
  const formHoldsOtherText = title !== "" || notes !== "";
  if (outcome === SAVED) return { message: formHoldsOtherText ? TEXT_LEFT_UNSAVED_WORDS : SAVED_WORDS, isProblem: false };
  if (outcome !== REFUSED) return { message: formHoldsOtherText ? `${message} ${TEXT_NOT_SENT_WORDS}` : message, isProblem: true };
  const formHoldsWhatWasSent = form.title.trim() === sent.title && form.notes.trim() === sent.notes;
  return formHoldsWhatWasSent ? { message, isProblem: true } : NO_STATUS;
}

export function AddEpicForm({ section, announce }: { section: PageSection; announce: (message: string) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState(NO_STATUS);
  const isSaving = useRef(false);
  const latestText = useRef({ title, notes });
  useLayoutEffect(() => {
    latestText.current = { title, notes };
  });

  function showStatus(message: string, isProblem: boolean) {
    setStatus({ message, isProblem });
    announce(message);
  }

  function clearStatus() {
    if (status.message !== "") showStatus("", false);
  }

  async function sendNewEpic(sent: EpicText): Promise<AddAnswer> {
    await refreshThePage(queryClient);
    const stored = shownPage(queryClient);
    const refusal = addEpicRefusal(sent.title, stored === undefined ? [] : readPage(stored).entries);
    if (refusal !== null) return { outcome: REFUSED, message: refusal };
    const notes = sent.notes === "" ? [] : notesLinesOf(sent.notes);
    return writeToTheStore("POST", "rows", { sectionId: section.id, listingToken: stored?.listing.listingToken ?? "", writer: THE_LORD, row: { kind: "epic", text: sent.title, freeLines: notes } });
  }

  async function addEpic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSaving.current) return showStatus(SAVE_ALREADY_ON_ITS_WAY_WORDS, true);
    isSaving.current = true;
    const sent = { title: title.trim(), notes: notes.trim() };
    showStatus("Saving.", false);
    const answer = await sendNewEpic(sent);
    isSaving.current = false;
    const form = latestText.current;
    const { message, isProblem } = statusAfterAnswer(answer, sent, form);
    showStatus(message, isProblem);
    if (answer.outcome !== SAVED) return;
    const textLeft = textBesidesWhatWasSent(form, sent);
    setTitle(textLeft.title);
    setNotes(textLeft.notes);
    await refreshThePage(queryClient);
  }

  return (
    <form className="add-epic" onSubmit={addEpic} onInput={clearStatus}>
      <label>
        Title
        <Input type="text" autoComplete="off" value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Notes
        <Textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      <div className="unit-controls">
        <Button type="submit" variant="outline">
          Add epic
        </Button>
        <span className={status.isProblem ? "unit-status problem" : "unit-status"}>{status.message}</span>
      </div>
    </form>
  );
}
