import { memo, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK_PLUGINS = [remarkGfm];

function PageLink({ href, children }: ComponentProps<"a">) {
  return (
    <a href={href} rel="noreferrer">
      {children}
    </a>
  );
}

const BLOCK_COMPONENTS: Components = { a: PageLink };
const INLINE_COMPONENTS: Components = { a: PageLink, p: ({ children }) => children };

export const MarkdownText = memo(function MarkdownText({ markdown }: { markdown: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={BLOCK_COMPONENTS}>
      {markdown}
    </Markdown>
  );
});

export function InlineMarkdown({ markdown }: { markdown: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={INLINE_COMPONENTS}>
      {markdown}
    </Markdown>
  );
}

export function UnsavedText({ text }: { text: string }) {
  return (
    <div className="unsaved">
      <p>Your text that was not saved:</p>
      <MarkdownText markdown={text} />
    </div>
  );
}
