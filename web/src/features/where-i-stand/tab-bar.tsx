import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { NavigationType, useNavigationType } from "react-router";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { pageTabs, selectedTabButton, tabLabel, TabName, type TabCounts } from "@/features/where-i-stand/page-tabs";

const TYPING_PAUSE_MILLISECONDS = 1000;
const LONGEST_KEY_THAT_TYPES_A_LETTER = 1;

function focusIsLeftBehind(): boolean {
  const focused = document.activeElement;
  return focused === document.body || focused?.getAttribute("role") === "tab" || Boolean(focused?.closest("[hidden]"));
}

function keepTabInsideItsBar(tab: HTMLElement) {
  const bar = tab.parentElement;
  if (bar === null) return;
  const tabEdges = tab.getBoundingClientRect();
  const barEdges = bar.getBoundingClientRect();
  bar.scrollLeft += Math.max(0, tabEdges.right - barEdges.right) + Math.min(0, tabEdges.left - barEdges.left);
}

function useTypingTowardsATab() {
  const typedWords = useRef("");
  const lastTypedAt = useRef(0);
  return function moveToTheTabBeingTyped(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.key.length !== LONGEST_KEY_THAT_TYPES_A_LETTER) return;
    const typingContinues = event.timeStamp - lastTypedAt.current < TYPING_PAUSE_MILLISECONDS;
    typedWords.current = `${typingContinues ? typedWords.current : ""}${event.key.toLowerCase()}`;
    lastTypedAt.current = event.timeStamp;
    const tab = pageTabs.find(({ words }) => words.toLowerCase().startsWith(typedWords.current));
    if (tab === undefined) return;
    event.preventDefault();
    event.currentTarget.querySelector<HTMLElement>(`[data-tab-name="${tab.name}"]`)?.focus();
  };
}

function useOpeningTheSelectedTab(selectedTabName: TabName, knownCounts: number) {
  const previousTabName = useRef(selectedTabName);
  useLayoutEffect(() => {
    if (selectedTabName === previousTabName.current) return;
    previousTabName.current = selectedTabName;
    if (focusIsLeftBehind()) selectedTabButton()?.focus();
    window.scrollTo(0, 0);
  }, [selectedTabName]);
  useEffect(() => {
    const tab = selectedTabButton();
    if (tab !== null) keepTabInsideItsBar(tab);
  }, [selectedTabName, knownCounts]);
}

function useFocusOnTheSelectedTabAfterBeingHidden() {
  const cameThroughHistory = useNavigationType() === NavigationType.Pop;
  const wasHidden = useRef(false);
  useLayoutEffect(() => {
    if (wasHidden.current && (cameThroughHistory || focusIsLeftBehind())) selectedTabButton()?.focus();
    wasHidden.current = false;
  });
  useLayoutEffect(
    () => () => {
      wasHidden.current = true;
    },
    [],
  );
}

interface TabBarProps {
  readonly selectedTabName: TabName;
  readonly counts: TabCounts | null;
  readonly needsYouCount: number;
}

export function TabBar({ selectedTabName, counts, needsYouCount }: TabBarProps) {
  const moveToTheTabBeingTyped = useTypingTowardsATab();
  useOpeningTheSelectedTab(selectedTabName, pageTabs.filter(({ name }) => counts?.[name] !== undefined).length);
  useFocusOnTheSelectedTabAfterBeingHidden();
  return (
    <TabsList variant="line" aria-label="Parts of the page" className="page-tabs" onKeyDown={moveToTheTabBeingTyped}>
      {pageTabs.map(({ name, words }) => {
        const tabNeedsYouCount = name === TabName.Now ? needsYouCount : 0;
        const count = counts?.[name];
        return (
          <TabsTrigger key={name} value={name} data-tab-name={name} aria-label={count === undefined ? words : tabLabel(words, count, tabNeedsYouCount)}>
            {words}
            {count !== undefined && <span className="tab-count">{count}</span>}
            {tabNeedsYouCount > 0 && <span className="tab-needs-you">{tabNeedsYouCount}</span>}
          </TabsTrigger>
        );
      })}
    </TabsList>
  );
}
