import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { ArchiveTab } from "@/features/where-i-stand/archive-tab";
import { describeRecordsTime, describeTime } from "@/features/where-i-stand/describe-times";
import { EpicsTab, isSaveShortcut } from "@/features/where-i-stand/epics-tab";
import { useFocusKeptWhenItsControlLeaves } from "@/features/where-i-stand/focus-kept";
import { UnsavedText } from "@/features/where-i-stand/markdown-text";
import { useRecords, useStoredPage } from "@/features/where-i-stand/page-queries";
import { controlOrSelectedTab, entryIsEpic, needsYouCountOf, pageTabsOf, selectedTabNameOf, tabCounts, tabNameOfSection, TabName } from "@/features/where-i-stand/page-tabs";
import { readPage } from "@/features/where-i-stand/read-page";
import { ReadOnlySections } from "@/features/where-i-stand/read-only-sections";
import { useNow } from "@/features/where-i-stand/row-age";
import { TabBar } from "@/features/where-i-stand/tab-bar";
import { useEpicEditors, type VanishedEpic } from "@/features/where-i-stand/use-epic-editors";
import { WorkSection } from "@/features/where-i-stand/work-section";
import "@/features/where-i-stand/where-i-stand.css";
import "@/features/where-i-stand/where-i-stand-rows.css";

const PAGE_TITLE = "Where I stand";
const VANISHED_EPIC_WORDS = "This epic changed on the page before you saved it, so your text was not saved.";
const LAST_FETCHED_WORDS = "Showing what was last fetched.";
const PAGE_FETCHED_AGAIN_WORDS = "The page was fetched again.";
const RECORDS_FETCHED_AGAIN_WORDS = "The pull request records were fetched again.";

interface ReadOutcome {
  readonly isError: boolean;
  readonly isSuccess: boolean;
}

function pageTimeWords(isRead: boolean, lastChangedAt: string | undefined, fetchFailed: boolean): string {
  if (lastChangedAt !== undefined) return `Page last changed ${describeTime(new Date(lastChangedAt))}`;
  if (isRead) return "Nothing is on the page yet.";
  return fetchFailed ? "" : "Fetching the page.";
}

function whatIsShownWords(somethingIsShown: boolean): string {
  return somethingIsShown ? LAST_FETCHED_WORDS : "Nothing has been fetched yet.";
}

function fetchProblemWords(fetchFailed: boolean, failedAt: number, somethingIsShown: boolean): string {
  if (!fetchFailed) return "";
  return `Could not fetch the page at ${describeTime(new Date(failedAt))}. ${whatIsShownWords(somethingIsShown)}`;
}

function useReadOutcomeAnnouncedOnce(read: ReadOutcome, failureWords: string, recoveryWords: string): string {
  const [regionWords, setRegionWords] = useState("");
  const wordsNow = regionWordsAfterRead(read, regionWords, failureWords, recoveryWords);
  if (wordsNow !== regionWords) setRegionWords(wordsNow);
  return wordsNow;
}

function regionWordsAfterRead({ isError, isSuccess }: ReadOutcome, regionWords: string, failureWords: string, recoveryWords: string): string {
  if (isError) return failureWords;
  return isSuccess && regionWords !== "" ? recoveryWords : regionWords;
}

function useBrowserSaveShortcutRefused() {
  useEffect(() => {
    function refuseBrowserSave(event: KeyboardEvent) {
      if (isSaveShortcut(event)) event.preventDefault();
    }
    document.addEventListener("keydown", refuseBrowserSave);
    return () => document.removeEventListener("keydown", refuseBrowserSave);
  }, []);
}

function usePageTitle() {
  useEffect(() => {
    const titleBefore = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = titleBefore;
    };
  }, []);
}

function useLinkFollowedFocusedOnRestoredPage() {
  useEffect(() => {
    let linkFollowed: HTMLAnchorElement | null = null;
    function rememberLinkFollowed(event: MouseEvent) {
      linkFollowed = (event.target as Element).closest("a");
    }
    function focusLinkFollowed(event: PageTransitionEvent) {
      if (event.persisted && linkFollowed !== null) controlOrSelectedTab(linkFollowed)?.focus({ preventScroll: true });
    }
    document.addEventListener("click", rememberLinkFollowed);
    window.addEventListener("pageshow", focusLinkFollowed);
    return () => {
      document.removeEventListener("click", rememberLinkFollowed);
      window.removeEventListener("pageshow", focusLinkFollowed);
    };
  }, []);
}

function useStatusRegion() {
  const region = useRef<HTMLParagraphElement>(null);
  const wordsAnsweredWhileHidden = useRef<string[]>([]);
  const writeStatus = useCallback((words: string) => {
    if (region.current === null) wordsAnsweredWhileHidden.current.push(words);
    else region.current.textContent = words;
  }, []);
  useEffect(() => {
    if (wordsAnsweredWhileHidden.current.length > 0) writeStatus(wordsAnsweredWhileHidden.current.join(" "));
    wordsAnsweredWhileHidden.current = [];
  }, [writeStatus]);
  return { region, writeStatus };
}

function useVanishedEpicsAnnounced(vanishedCount: number, writeStatus: (words: string) => void) {
  const countBefore = useRef(0);
  useEffect(() => {
    if (vanishedCount > countBefore.current) writeStatus(VANISHED_EPIC_WORDS);
    if (vanishedCount === 0) writeStatus("");
    countBefore.current = vanishedCount;
  }, [vanishedCount, writeStatus]);
}

function useTabsVisited(selectedTabName: TabName): ReadonlySet<TabName> {
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<TabName>>(new Set([selectedTabName]));
  if (!visitedTabs.has(selectedTabName)) setVisitedTabs(new Set(visitedTabs).add(selectedTabName));
  return visitedTabs;
}

function VanishedEpicNotice({ vanished, onDismiss }: { vanished: VanishedEpic; onDismiss: () => void }) {
  return (
    <section>
      <p className="problem">{VANISHED_EPIC_WORDS}</p>
      <UnsavedText text={vanished.text} />
      <Button type="button" variant="outline" size="sm" aria-label={`Dismiss the notice about ${vanished.name} epic`} onClick={onDismiss}>
        Dismiss
      </Button>
    </section>
  );
}

const NO_PAGE = { tabs: [], sections: [], archivedSections: [], entries: [], listingToken: "", lastChangedAt: undefined };

export function WhereIStandPage() {
  const storedPage = useStoredPage();
  const recordsQuery = useRecords();
  const navigate = useNavigate();
  const stored = storedPage.data;
  const now = useNow(stored?.now);
  const page = useMemo(() => (stored === undefined ? NO_PAGE : readPage(stored)), [stored]);
  const tabs = useMemo(() => pageTabsOf(page.tabs), [page.tabs]);
  const selectedTabName = selectedTabNameOf(useLocation().hash, tabs);
  const visitedTabs = useTabsVisited(selectedTabName);
  const { region: announcementRegion, writeStatus: announce } = useStatusRegion();
  const { region: vanishedEpicRegion, writeStatus: writeVanishedEpicStatus } = useStatusRegion();
  useBrowserSaveShortcutRefused();
  usePageTitle();
  useLinkFollowedFocusedOnRestoredPage();

  const records = recordsQuery.data?.records;
  const epicsSection = page.sections.find((section) => tabNameOfSection(section, tabs) === TabName.Epics);
  const editors = useEpicEditors(epicsSection?.entries, announce);
  useFocusKeptWhenItsControlLeaves(editors.controlTakingFocus);
  useVanishedEpicsAnnounced(editors.vanishedEpics.length, writeVanishedEpicStatus);

  const recordsFailed = recordsQuery.isError;
  const recordsReadAt = Math.max(recordsQuery.dataUpdatedAt, recordsQuery.errorUpdatedAt);
  const recordsTime = describeRecordsTime(records, recordsFailed ? recordsQuery.errorUpdatedAt : null, recordsReadAt);
  const countsAreKnown = stored !== undefined;
  const pageReadWords = useReadOutcomeAnnouncedOnce(storedPage, `Could not fetch the page. ${whatIsShownWords(stored !== undefined)}`, PAGE_FETCHED_AGAIN_WORDS);
  const recordsReadWords = useReadOutcomeAnnouncedOnce(recordsQuery, `Could not fetch the pull request records. ${records === undefined ? "" : LAST_FETCHED_WORDS}`.trim(), RECORDS_FETCHED_AGAIN_WORDS);

  useEffect(() => {
    const hash = window.location.hash;
    if (tabs.length > 0 && hash !== "" && hash !== `#${selectedTabName}`) void navigate({ hash: selectedTabName }, { replace: true });
  }, [tabs.length, selectedTabName, navigate]);

  function openTab(tabName: string) {
    if (window.location.hash !== `#${tabName}`) void navigate({ hash: tabName });
  }

  function panelContent(tabName: TabName) {
    if (tabName === TabName.Archive) return <ArchiveTab sections={page.sections} archivedSections={page.archivedSections} now={now} announce={announce} />;
    if (tabName === TabName.Epics) return <EpicsTab section={epicsSection} editors={editors} announce={announce} now={now} />;
    return (
      <>
        {tabName === TabName.PullRequests && <WorkSection records={records} recordsAreOnTheirWay={recordsQuery.isPending} entries={page.entries.filter((entry) => !entryIsEpic(entry) && entry.row.kind === "work")} recordsTime={recordsTime} now={recordsReadAt} />}
        <ReadOnlySections tab={tabs.find(({ name }) => name === tabName)} sections={page.sections} archivedSections={page.archivedSections} now={now} announce={announce} />
      </>
    );
  }

  return (
    <div className="where-i-stand">
      <header>
        <h1>{PAGE_TITLE}</h1>
        <p>{pageTimeWords(stored !== undefined, page.lastChangedAt, storedPage.isError)}</p>
        <p className="fetch-problem">{fetchProblemWords(storedPage.isError, storedPage.errorUpdatedAt, stored !== undefined)}</p>
        <p ref={announcementRegion} className="visually-hidden" role="status" />
        <p className="visually-hidden" role="status">
          {pageReadWords}
        </p>
        <p className="visually-hidden" role="status">
          {recordsReadWords}
        </p>
        <p ref={vanishedEpicRegion} className="visually-hidden" role="status" />
      </header>
      <Tabs className="gap-4" value={selectedTabName} onValueChange={openTab}>
        <TabBar tabs={tabs} selectedTabName={selectedTabName} counts={countsAreKnown ? tabCounts(tabs, page.sections, records) : null} needsYouCount={needsYouCountOf(page.entries)} />
        {editors.vanishedEpics.map((vanished) => (
          <VanishedEpicNotice key={vanished.id} vanished={vanished} onDismiss={() => editors.closeEditor(vanished.id)} />
        ))}
        {tabs.map(({ name }) => (
          <TabsContent key={name} value={name} forceMount hidden={name !== selectedTabName} tabIndex={name === TabName.Epics ? undefined : 0}>
            {visitedTabs.has(name) && panelContent(name)}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
