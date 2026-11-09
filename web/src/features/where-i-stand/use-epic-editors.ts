import type { SaveRequest, SaveResponse } from "@contract/where-i-stand.ts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { epicsToldApart, epicWithNotes, notesOf, notesRefusal, occurrenceOfRepeatedHeading } from "@/features/where-i-stand/epic-markdown";
import { refreshThePage } from "@/features/where-i-stand/page-queries";
import { controlOrSelectedTab } from "@/features/where-i-stand/page-tabs";
import type { PageEntry } from "@/features/where-i-stand/read-page";
import { SAVE_ALREADY_ON_ITS_WAY_WORDS, savePageUnit } from "@/features/where-i-stand/save-page-unit";

const REMOVED = "";
const SAVING_WORDS = "Saving.";
const UNCHANGED_WORDS = "Nothing to save: this epic is as it was loaded.";
const UNSAVED_CHANGES_WORDS = "Unsaved changes.";
const KEPT_TEXTS_SEPARATOR = "\n\n";
const NO_EPICS: readonly PageEntry[] = [];
const BOX_SETTLES_BEFORE_SPEAKING_MILLISECONDS = 200;
const OUTCOMES_THAT_RELOAD_THE_EPIC: readonly SaveResponse["outcome"][] = ["saved", "unchanged", "entry-changed"];

export interface EpicDraft {
  readonly loaded: string;
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
  readonly identity: string;
  readonly neighbour: PageEntry | undefined;
}

export interface VanishedEpic {
  readonly identity: string;
  readonly text: string;
}

export const CLOSED_EPIC: EpicState = { isOpen: false, draft: null, status: "", isProblem: false, unsavedText: "", isSavingNotes: false, isBeingRemoved: false };

function notesAreAsLoaded({ loaded, text }: EpicDraft): boolean {
  return text === notesOf(loaded);
}

function draftChangesTheEpic({ loaded, text }: EpicDraft): boolean {
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

function draftAfterSaving(draft: EpicDraft | null, saved: string): EpicDraft | null {
  if (draft === null || epicWithNotes(draft.loaded, draft.text) === saved) return null;
  return { ...draft, loaded: saved };
}

function changeSavedFrom(epic: PageEntry, epics: readonly PageEntry[], state: EpicState): SaveRequest {
  const loaded = state.draft?.loaded ?? epic.markdown;
  return { loaded, edited: state.draft === null ? loaded : epicWithNotes(loaded, state.draft.text), headingOccurrence: occurrenceOfRepeatedHeading(epic, epics) };
}

function stateAfterAnswer(state: EpicState, change: SaveRequest, { outcome, message }: SaveResponse): Partial<EpicState> & { status: string } {
  if (outcome === "entry-changed") return { draft: null, status: message, isProblem: true, unsavedText: wordsHeldBy(state) };
  const draftLeft = draftAfterSaving(state.draft, change.edited);
  return { draft: draftLeft, status: draftLeft === null ? message : UNSAVED_CHANGES_WORDS, isProblem: false };
}

function stateAfterTyping({ draft, isSavingNotes }: EpicState, epic: PageEntry, text: string): Partial<EpicState> & { status: string } {
  const typed = { loaded: draft?.loaded ?? epic.markdown, text };
  const boxDiffersFromTheFile = isSavingNotes || !notesAreAsLoaded(typed);
  const isUnsaved = draftIsUnsaved({ draft: typed, isSavingNotes });
  return { draft: boxDiffersFromTheFile ? typed : null, status: isUnsaved ? UNSAVED_CHANGES_WORDS : "", isProblem: false };
}

function vanishedEpicsOf(epicStates: ReadonlyMap<string, EpicState>, epics: readonly PageEntry[]): VanishedEpic[] {
  const identitiesOnThePage = new Set(epics.map(({ identity }) => identity));
  return [...epicStates].flatMap(([identity, state]) => {
    const text = wordsHeldBy(state);
    return identitiesOnThePage.has(identity) || text === "" ? [] : [{ identity, text }];
  });
}

function epicsAfterSaving(epics: readonly PageEntry[], identity: string, edited: string): readonly PageEntry[] {
  if (edited === REMOVED) return epics.filter((epic) => epic.identity !== identity);
  return epics.map((epic) => (epic.identity === identity ? { ...epic, markdown: edited } : epic));
}

function useEpicsToldApart(entries: readonly PageEntry[]) {
  const [entriesRead, setEntriesRead] = useState(entries);
  const [epics, setEpics] = useState<readonly PageEntry[]>(() => epicsToldApart([], entries));
  if (entries !== entriesRead) {
    setEntriesRead(entries);
    setEpics(epicsToldApart(epics, entries));
  }
  return { epics, rememberSavedEpic: (identity: string, edited: string) => setEpics((current) => epicsAfterSaving(current, identity, edited)) };
}

export function useEpicEditors(entries: readonly PageEntry[] | undefined, announce: (message: string) => void) {
  const queryClient = useQueryClient();
  const { epics, rememberSavedEpic } = useEpicsToldApart(entries ?? NO_EPICS);
  const [epicStates, setEpicStates] = useState<ReadonlyMap<string, EpicState>>(new Map());
  const epicsBeingSent = useRef(new Set<string>());
  const toggleButtons = useRef(new Map<string, HTMLButtonElement>());
  const latestEpicStates = useRef(epicStates);
  const removalOnItsWay = useRef<RemovalOnItsWay | null>(null);
  useLayoutEffect(() => {
    latestEpicStates.current = epicStates;
  });
  useEffect(() => {
    const removedEpicHasLeft = !epics.some(({ identity }) => identity === removalOnItsWay.current?.identity);
    if (removedEpicHasLeft) removalOnItsWay.current = null;
  });

  function changeEpicState(identity: string, change: (state: EpicState) => Partial<EpicState>) {
    setEpicStates((current) => {
      const state = current.get(identity) ?? CLOSED_EPIC;
      return new Map(current).set(identity, { ...state, ...change(state) });
    });
  }

  function forgetEpicState(identity: string) {
    setEpicStates((current) => {
      const remaining = new Map(current);
      remaining.delete(identity);
      return remaining;
    });
  }

  function latestStateOf(identity: string): EpicState {
    return latestEpicStates.current.get(identity) ?? CLOSED_EPIC;
  }

  function announceIfStatusChanges(identity: string, status: string) {
    if (latestStateOf(identity).status !== status) announce(status);
  }

  function closeEpicEditor(identity: string) {
    announceIfStatusChanges(identity, CLOSED_EPIC.status);
    changeEpicState(identity, ({ isBeingRemoved }) => ({ ...CLOSED_EPIC, isBeingRemoved }));
  }

  function showSaveState(identity: string, message: string, isProblem: boolean) {
    changeEpicState(identity, () => ({ status: message, isProblem }));
    announce(message);
  }

  function showAnswer(identity: string, change: SaveRequest, answer: SaveResponse) {
    const stateAfter = stateAfterAnswer(latestStateOf(identity), change, answer);
    changeEpicState(identity, () => stateAfter);
    if (answer.outcome === "entry-changed") setTimeout(() => announce(stateAfter.status), BOX_SETTLES_BEFORE_SPEAKING_MILLISECONDS);
    else announce(stateAfter.status);
  }

  function controlTakingFocus(): HTMLElement | null {
    const neighbour = removalOnItsWay.current?.neighbour;
    const neighbourToggle = neighbour === undefined ? undefined : toggleButtons.current.get(neighbour.identity);
    return controlOrSelectedTab(neighbourToggle);
  }

  function refuseSecondSend(identity: string) {
    showSaveState(identity, SAVE_ALREADY_ON_ITS_WAY_WORDS, true);
  }

  function keepEpicAfterFailedRemoval(identity: string) {
    removalOnItsWay.current = null;
    changeEpicState(identity, () => ({ isBeingRemoved: false }));
  }

  async function sendChange(identity: string, change: SaveRequest) {
    if (change.edited === change.loaded) return showSaveState(identity, UNCHANGED_WORDS, false);
    epicsBeingSent.current.add(identity);
    showSaveState(identity, SAVING_WORDS, false);
    const answer = await savePageUnit(change);
    const isRemoval = change.edited === REMOVED;
    const wasRemoved = isRemoval && answer.outcome === "saved";
    if (isRemoval && !wasRemoved) keepEpicAfterFailedRemoval(identity);
    if (!OUTCOMES_THAT_RELOAD_THE_EPIC.includes(answer.outcome)) {
      epicsBeingSent.current.delete(identity);
      return showSaveState(identity, answer.message, true);
    }
    if (answer.outcome === "saved") rememberSavedEpic(identity, change.edited);
    if (wasRemoved) forgetEpicState(identity);
    await refreshThePage(queryClient);
    epicsBeingSent.current.delete(identity);
    if (!wasRemoved) return showAnswer(identity, change, answer);
    announce(answer.message);
  }

  function stateOf({ identity }: PageEntry): EpicState {
    return epicStates.get(identity) ?? CLOSED_EPIC;
  }

  async function saveEpic(epic: PageEntry) {
    if (epicsBeingSent.current.has(epic.identity)) return refuseSecondSend(epic.identity);
    const refusal = notesRefusal(stateOf(epic).draft?.text ?? "");
    if (refusal !== null) return showSaveState(epic.identity, refusal, true);
    changeEpicState(epic.identity, () => ({ isSavingNotes: true }));
    await sendChange(epic.identity, changeSavedFrom(epic, epics, stateOf(epic)));
    changeEpicState(epic.identity, ({ draft }) => ({ isSavingNotes: false, draft: draft !== null && notesAreAsLoaded(draft) ? null : draft }));
  }

  function typeNotes(epic: PageEntry, text: string) {
    announceIfStatusChanges(epic.identity, stateAfterTyping(latestStateOf(epic.identity), epic, text).status);
    changeEpicState(epic.identity, (state) => stateAfterTyping(state, epic, text));
  }

  function neighbourOf(epic: PageEntry): PageEntry | undefined {
    const position = epics.indexOf(epic);
    return epics[position + 1] ?? epics[position - 1];
  }

  async function removeEpic(epic: PageEntry) {
    if (epicsBeingSent.current.has(epic.identity)) return refuseSecondSend(epic.identity);
    removalOnItsWay.current = { identity: epic.identity, neighbour: neighbourOf(epic) };
    changeEpicState(epic.identity, () => ({ isBeingRemoved: true }));
    await sendChange(epic.identity, { ...changeSavedFrom(epic, epics, stateOf(epic)), edited: REMOVED });
  }

  return {
    epics,
    stateOf,
    typeNotes,
    vanishedEpics: vanishedEpicsOf(epicStates, epics),
    openEditor: (epic: PageEntry) => changeEpicState(epic.identity, () => ({ isOpen: true })),
    closeEditor: closeEpicEditor,
    closeEditorOntoItsToggle: (identity: string) => {
      toggleButtons.current.get(identity)?.focus();
      closeEpicEditor(identity);
    },
    saveEpic,
    removeEpic,
    controlTakingFocus,
    rememberToggleButton: (identity: string, button: HTMLButtonElement | null) => {
      if (button === null) toggleButtons.current.delete(identity);
      else toggleButtons.current.set(identity, button);
    },
  };
}

export type EpicEditors = ReturnType<typeof useEpicEditors>;
