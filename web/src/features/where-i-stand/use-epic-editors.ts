import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { epicWithNotes, notesOf } from "@/features/where-i-stand/epic-markdown";
import { refreshThePage, SAVE_ALREADY_ON_ITS_WAY_WORDS, THE_LORD, writeToTheStore, type WriteAnswer } from "@/features/where-i-stand/page-queries";
import { controlOrSelectedTab } from "@/features/where-i-stand/page-tabs";
import { entryOfRow, type PageEntry } from "@/features/where-i-stand/read-page";

const SAVING_WORDS = "Saving.";
const SAVED_WORDS = "Saved.";
export const REMOVED_WORDS = "Removed. It is kept under Archived at the foot of this tab.";
const UNCHANGED_WORDS = "Nothing to save: this epic is as it was loaded.";
const UNSAVED_CHANGES_WORDS = "Unsaved changes.";
const CHANGED_BEFORE_REMOVAL_WORDS = "Not removed: this epic changed since the page loaded, and nothing was archived. Here is the current one.";
const KEPT_TEXTS_SEPARATOR = "\n\n";
const NO_EPICS: readonly PageEntry[] = [];
const BOX_SETTLES_BEFORE_SPEAKING_MILLISECONDS = 200;

export interface EpicDraft {
  readonly loaded: string;
  readonly loadedChangedAt: string;
  readonly text: string;
}

export interface EpicState {
  readonly isOpen: boolean;
  readonly draft: EpicDraft | null;
  readonly status: string;
  readonly isProblem: boolean;
  readonly unsavedText: string;
  readonly isSavingNotes: boolean;
  readonly isBeingRemoved: boolean;
}

interface RemovalOnItsWay {
  readonly id: string;
  readonly neighbour: PageEntry | undefined;
}

export interface VanishedEpic {
  readonly id: string;
  readonly name: string;
  readonly text: string;
}

export const CLOSED_EPIC: EpicState = { isOpen: false, draft: null, status: "", isProblem: false, unsavedText: "", isSavingNotes: false, isBeingRemoved: false };

function notesAreAsLoaded({ loaded, text }: Pick<EpicDraft, "loaded" | "text">): boolean {
  return text === notesOf(loaded);
}

function draftChangesTheEpic({ loaded, text }: Pick<EpicDraft, "loaded" | "text">): boolean {
  return epicWithNotes(loaded, text) !== loaded;
}

export function draftIsUnsaved({ draft, isSavingNotes }: Pick<EpicState, "draft" | "isSavingNotes">): boolean {
  return draft !== null && (isSavingNotes || draftChangesTheEpic(draft));
}

export function holdsUnsavedWords(state: EpicState): boolean {
  return draftIsUnsaved(state) || state.unsavedText !== "";
}

function wordsHeldBy(state: EpicState): string {
  const draftWords = draftIsUnsaved(state) ? (state.draft?.text ?? "") : "";
  return [state.unsavedText, draftWords].filter((words) => words !== "").join(KEPT_TEXTS_SEPARATOR);
}

function draftOf(epic: PageEntry, state: EpicState): EpicDraft {
  return state.draft ?? { loaded: epic.markdown, loadedChangedAt: epic.row.changedAt, text: notesOf(epic.markdown) };
}

function draftAfterSaving(draft: EpicDraft | null, sent: string, saved: PageEntry | undefined): EpicDraft | null {
  if (draft === null || saved === undefined || epicWithNotes(draft.loaded, draft.text) === sent) return null;
  return { ...draft, loaded: saved.markdown, loadedChangedAt: saved.row.changedAt };
}

function stateAfterAnswer(state: EpicState, sent: string, answer: WriteAnswer): Partial<EpicState> & { status: string } {
  if (answer.outcome === "refused") return { draft: null, status: answer.message, isProblem: true, unsavedText: wordsHeldBy(state) };
  const saved = answer.row === undefined ? undefined : entryOfRow(answer.row, "");
  const draftLeft = draftAfterSaving(state.draft, sent, saved);
  return { draft: draftLeft, status: draftLeft === null ? SAVED_WORDS : UNSAVED_CHANGES_WORDS, isProblem: false };
}

function stateAfterTyping({ draft, isSavingNotes }: EpicState, epic: PageEntry, text: string): Partial<EpicState> & { status: string } {
  const typed = { loaded: draft?.loaded ?? epic.markdown, loadedChangedAt: draft?.loadedChangedAt ?? epic.row.changedAt, text };
  const boxDiffersFromTheStore = isSavingNotes || !notesAreAsLoaded(typed);
  const isUnsaved = draftIsUnsaved({ draft: typed, isSavingNotes });
  return { draft: boxDiffersFromTheStore ? typed : null, status: isUnsaved ? UNSAVED_CHANGES_WORDS : "", isProblem: false };
}

function vanishedEpicsOf(epicStates: ReadonlyMap<string, EpicState>, names: ReadonlyMap<string, string>, epics: readonly PageEntry[]): VanishedEpic[] {
  const idsOnThePage = new Set(epics.map(({ id }) => id));
  return [...epicStates].flatMap(([id, state]) => {
    const text = wordsHeldBy(state);
    return idsOnThePage.has(id) || text === "" ? [] : [{ id, name: names.get(id) ?? id, text }];
  });
}

function useNamesOfEpicsSeen(epics: readonly PageEntry[]): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const unseen = epics.filter(({ id, identity }) => names.get(id) !== identity);
  if (unseen.length > 0) setNames(new Map([...names, ...unseen.map(({ id, identity }): [string, string] => [id, identity])]));
  return names;
}

export function useEpicEditors(entries: readonly PageEntry[] | undefined, announce: (message: string) => void) {
  const queryClient = useQueryClient();
  const epics = entries ?? NO_EPICS;
  const names = useNamesOfEpicsSeen(epics);
  const [epicStates, setEpicStates] = useState<ReadonlyMap<string, EpicState>>(new Map());
  const epicsBeingSent = useRef(new Set<string>());
  const toggleButtons = useRef(new Map<string, HTMLButtonElement>());
  const latestEpicStates = useRef(epicStates);
  const removalOnItsWay = useRef<RemovalOnItsWay | null>(null);
  useLayoutEffect(() => {
    latestEpicStates.current = epicStates;
  });
  useEffect(() => {
    const removedEpicHasLeft = !epics.some(({ id }) => id === removalOnItsWay.current?.id);
    if (removedEpicHasLeft) removalOnItsWay.current = null;
  });

  function changeEpicState(id: string, change: (state: EpicState) => Partial<EpicState>) {
    setEpicStates((current) => {
      const state = current.get(id) ?? CLOSED_EPIC;
      return new Map(current).set(id, { ...state, ...change(state) });
    });
  }

  function forgetEpicState(id: string) {
    setEpicStates((current) => {
      const remaining = new Map(current);
      remaining.delete(id);
      return remaining;
    });
  }

  function latestStateOf(id: string): EpicState {
    return latestEpicStates.current.get(id) ?? CLOSED_EPIC;
  }

  function announceIfStatusChanges(id: string, status: string) {
    if (latestStateOf(id).status !== status) announce(status);
  }

  function closeEpicEditor(id: string) {
    announceIfStatusChanges(id, CLOSED_EPIC.status);
    changeEpicState(id, ({ isBeingRemoved }) => ({ ...CLOSED_EPIC, isBeingRemoved }));
  }

  function showSaveState(id: string, message: string, isProblem: boolean) {
    changeEpicState(id, () => ({ status: message, isProblem }));
    announce(message);
  }

  function showAnswer(id: string, sent: string, answer: WriteAnswer) {
    const stateAfter = stateAfterAnswer(latestStateOf(id), sent, answer);
    changeEpicState(id, () => stateAfter);
    if (answer.outcome === "refused") setTimeout(() => announce(stateAfter.status), BOX_SETTLES_BEFORE_SPEAKING_MILLISECONDS);
    else announce(stateAfter.status);
  }

  function controlTakingFocus(): HTMLElement | null {
    const neighbour = removalOnItsWay.current?.neighbour;
    const neighbourToggle = neighbour === undefined ? undefined : toggleButtons.current.get(neighbour.id);
    return controlOrSelectedTab(neighbourToggle);
  }

  function refuseSecondSend(id: string) {
    showSaveState(id, SAVE_ALREADY_ON_ITS_WAY_WORDS, true);
  }

  function keepEpicAfterFailedRemoval(id: string) {
    removalOnItsWay.current = null;
    changeEpicState(id, () => ({ isBeingRemoved: false }));
  }

  async function sendNotes(epic: PageEntry, draft: EpicDraft) {
    const sent = epicWithNotes(draft.loaded, draft.text);
    if (sent === draft.loaded) return showSaveState(epic.id, UNCHANGED_WORDS, false);
    epicsBeingSent.current.add(epic.id);
    showSaveState(epic.id, SAVING_WORDS, false);
    const answer = await writeToTheStore("PUT", `rows/${epic.id}`, { writer: THE_LORD, row: { freeLines: sent.split("\n").slice(1) }, loadedChangedAt: draft.loadedChangedAt });
    const epicIsAsLoaded = answer.outcome === "refused" && answer.row?.changedAt === draft.loadedChangedAt;
    if (answer.outcome === "failed" || epicIsAsLoaded || (answer.outcome === "refused" && answer.row === undefined)) {
      epicsBeingSent.current.delete(epic.id);
      return showSaveState(epic.id, answer.message, true);
    }
    await refreshThePage(queryClient);
    epicsBeingSent.current.delete(epic.id);
    showAnswer(epic.id, sent, answer);
  }

  async function sendRemoval(epic: PageEntry, loadedChangedAt: string): Promise<WriteAnswer> {
    const answer = await writeToTheStore("POST", `rows/${epic.id}/archive`, { writer: THE_LORD, loadedChangedAt }, "Not removed");
    return answer.outcome === "refused" && answer.row !== undefined ? { ...answer, message: CHANGED_BEFORE_REMOVAL_WORDS } : answer;
  }

  function stateOf({ id }: PageEntry): EpicState {
    return epicStates.get(id) ?? CLOSED_EPIC;
  }

  async function saveEpic(epic: PageEntry) {
    if (epicsBeingSent.current.has(epic.id)) return refuseSecondSend(epic.id);
    changeEpicState(epic.id, () => ({ isSavingNotes: true }));
    await sendNotes(epic, draftOf(epic, stateOf(epic)));
    changeEpicState(epic.id, ({ draft }) => ({ isSavingNotes: false, draft: draft !== null && notesAreAsLoaded(draft) ? null : draft }));
  }

  function typeNotes(epic: PageEntry, text: string) {
    announceIfStatusChanges(epic.id, stateAfterTyping(latestStateOf(epic.id), epic, text).status);
    changeEpicState(epic.id, (state) => stateAfterTyping(state, epic, text));
  }

  function neighbourOf(epic: PageEntry): PageEntry | undefined {
    const position = epics.indexOf(epic);
    return epics[position + 1] ?? epics[position - 1];
  }

  async function removeEpic(epic: PageEntry) {
    if (epicsBeingSent.current.has(epic.id)) return refuseSecondSend(epic.id);
    removalOnItsWay.current = { id: epic.id, neighbour: neighbourOf(epic) };
    changeEpicState(epic.id, () => ({ isBeingRemoved: true }));
    epicsBeingSent.current.add(epic.id);
    showSaveState(epic.id, SAVING_WORDS, false);
    const answer = await sendRemoval(epic, draftOf(epic, stateOf(epic)).loadedChangedAt);
    if (answer.outcome !== "done") {
      epicsBeingSent.current.delete(epic.id);
      keepEpicAfterFailedRemoval(epic.id);
      if (answer.outcome === "failed") return showSaveState(epic.id, answer.message, true);
      await refreshThePage(queryClient);
      return showAnswer(epic.id, "", answer);
    }
    forgetEpicState(epic.id);
    await refreshThePage(queryClient);
    epicsBeingSent.current.delete(epic.id);
    announce(REMOVED_WORDS);
  }

  return {
    epics,
    stateOf,
    typeNotes,
    vanishedEpics: vanishedEpicsOf(epicStates, names, epics),
    openEditor: (epic: PageEntry) => changeEpicState(epic.id, () => ({ isOpen: true })),
    closeEditor: closeEpicEditor,
    closeEditorOntoItsToggle: (id: string) => {
      toggleButtons.current.get(id)?.focus();
      closeEpicEditor(id);
    },
    saveEpic,
    removeEpic,
    controlTakingFocus,
    rememberToggleButton: (id: string, button: HTMLButtonElement | null) => {
      if (button === null) toggleButtons.current.delete(id);
      else toggleButtons.current.set(id, button);
    },
  };
}

export type EpicEditors = ReturnType<typeof useEpicEditors>;
