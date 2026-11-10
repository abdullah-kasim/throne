import { MarkdownText } from "@/features/where-i-stand/markdown-text";
import { useArchive } from "@/features/where-i-stand/page-queries";

export const EMPTY_ARCHIVE_WORDS = "Nothing has been archived yet.";
export const ARCHIVE_FAILED_WORDS = "Could not fetch the archive.";
const ARCHIVE_OPENING_WORDS = "Older delivered entries, moved here whole from the page. Read only.";

function archiveWords(markdown: string | undefined, fetchFailed: boolean): string {
  if (markdown === undefined) return fetchFailed ? ARCHIVE_FAILED_WORDS : "Fetching the archive.";
  return markdown.trim() === "" ? EMPTY_ARCHIVE_WORDS : ARCHIVE_OPENING_WORDS;
}

export function ArchiveTab() {
  const archive = useArchive();
  const markdown = archive.data?.markdown;
  return (
    <section>
      <p>{archiveWords(markdown, archive.isError)}</p>
      {markdown !== undefined && <MarkdownText markdown={markdown} />}
    </section>
  );
}
