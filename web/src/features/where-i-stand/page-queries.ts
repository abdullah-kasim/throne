import { archivedRowsResponse, failedResponse, recordsResponse, storedPage, writeResponse, type StoredPage, type WriteResponse } from "@contract/where-i-stand.ts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchParsed, sendParsed } from "@/lib/api-client";

const REFRESH_INTERVAL_MILLISECONDS = 60000;
const ALL_PAGE_QUERIES_KEY = ["where-i-stand"];
const STORED_PAGE_QUERY_KEY = [...ALL_PAGE_QUERIES_KEY, "page"];
const RECORDS_QUERY_KEY = [...ALL_PAGE_QUERIES_KEY, "records"];
const ARCHIVED_ROWS_QUERY_KEY = [...ALL_PAGE_QUERIES_KEY, "archived-rows"];
const STORE_PATH = "where-i-stand/store";
const NOT_SAVED_WORDS = "Not saved";

export const THE_LORD = "Lord";
export const SAVE_ALREADY_ON_ITS_WAY_WORDS = "Not sent: a save is already on its way.";

export type WriteAnswer = WriteResponse | { readonly outcome: "failed"; readonly message: string; readonly row?: undefined };

export function useStoredPage() {
  return useQuery({
    queryKey: STORED_PAGE_QUERY_KEY,
    queryFn: () => fetchParsed(`${STORE_PATH}/page`, storedPage),
    refetchInterval: REFRESH_INTERVAL_MILLISECONDS,
  });
}

export function useRecords() {
  return useQuery({
    queryKey: RECORDS_QUERY_KEY,
    queryFn: () => fetchParsed("where-i-stand/records", recordsResponse),
    refetchInterval: REFRESH_INTERVAL_MILLISECONDS,
  });
}

export function useArchivedRows(sectionId: string, isOpen: boolean) {
  return useQuery({
    queryKey: [...ARCHIVED_ROWS_QUERY_KEY, sectionId],
    queryFn: () => fetchParsed(`${STORE_PATH}/sections/${sectionId}/archived-rows`, archivedRowsResponse),
    enabled: isOpen,
    refetchInterval: isOpen ? REFRESH_INTERVAL_MILLISECONDS : false,
  });
}

function failureWords(error: unknown, notDoneWords: string): string {
  if (error instanceof TypeError) return `${notDoneWords}: the backend could not be reached.`;
  return `${notDoneWords}: ${error instanceof Error ? error.message : String(error)}.`;
}

export async function writeToTheStore(method: "POST" | "PUT", path: string, body: unknown, notDoneWords = NOT_SAVED_WORDS): Promise<WriteAnswer> {
  try {
    return await sendParsed(`${STORE_PATH}/${path}`, method, body, writeResponse.or(failedResponse));
  } catch (error) {
    return { outcome: "failed", message: failureWords(error, notDoneWords) };
  }
}

function untilObserversHaveRendered(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

export async function refreshThePage(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ALL_PAGE_QUERIES_KEY });
  await untilObserversHaveRendered();
}

export function shownPage(queryClient: QueryClient): StoredPage | undefined {
  return queryClient.getQueryData<StoredPage>(STORED_PAGE_QUERY_KEY);
}
