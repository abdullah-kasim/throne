import { pageResponse, recordsResponse, type PageResponse } from "@contract/where-i-stand.ts";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { fetchParsed } from "@/lib/api-client";

const REFRESH_INTERVAL_MILLISECONDS = 60000;
const ALL_PAGE_QUERIES_KEY = ["where-i-stand"];
const STORED_PAGE_QUERY_KEY = [...ALL_PAGE_QUERIES_KEY, "page"];
const RECORDS_QUERY_KEY = [...ALL_PAGE_QUERIES_KEY, "records"];

export function useStoredPage() {
  return useQuery({
    queryKey: STORED_PAGE_QUERY_KEY,
    queryFn: () => fetchParsed("where-i-stand/page", pageResponse),
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

function untilObserversHaveRendered(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

export async function refreshThePage(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ALL_PAGE_QUERIES_KEY });
  await untilObserversHaveRendered();
}

export function shownMarkdown(queryClient: QueryClient): string {
  return queryClient.getQueryData<PageResponse>(STORED_PAGE_QUERY_KEY)?.markdown ?? "";
}
