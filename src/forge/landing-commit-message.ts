import { titleAfterDraftPrefixAndMarker } from "./forgejo-pull-request-titles.ts";
import type { PullRequestView } from "./pull-request-shapes.ts";

const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const SPOILER_LABEL_PATTERN = /<summary\b[^>]*>[\s\S]*?<\/summary>/gi;
const SPOILER_TAG_PATTERN = /<\/?details\b[^>]*>/gi;
const HUMAN_SECTION_PATTERN = /^## What \(human\)[ \t]*\n([\s\S]*?)(?=^#{1,2} |(?![\s\S]))/m;
const UNFILLED_HUMAN_SECTION = "Human text goes here.";
const PARAGRAPH_BREAK_PATTERN = /\n[ \t]*\n/;
const HEADING_LINE_PATTERN = /^#{1,6}\s/;

function bodyWithoutRecordsAndSpoilers(body: string): string {
  return body.replace(HTML_COMMENT_PATTERN, "").replace(SPOILER_LABEL_PATTERN, "").replace(SPOILER_TAG_PATTERN, "");
}

function humanSectionText(body: string): string {
  const text = HUMAN_SECTION_PATTERN.exec(body)?.[1]?.trim() ?? "";
  return text === UNFILLED_HUMAN_SECTION ? "" : text;
}

function isHeadingOnly(paragraph: string): boolean {
  return paragraph.split("\n").every((line) => HEADING_LINE_PATTERN.test(line));
}

function firstParagraph(body: string): string {
  const paragraphs = body.replace(HUMAN_SECTION_PATTERN, "").split(PARAGRAPH_BREAK_PATTERN).map((paragraph) => paragraph.trim());
  return paragraphs.find((paragraph) => paragraph !== "" && !isHeadingOnly(paragraph)) ?? "";
}

export function pullRequestBodySummary(body: string): string {
  const plainBody = bodyWithoutRecordsAndSpoilers(body.replaceAll("\r\n", "\n"));
  const humanText = humanSectionText(plainBody);
  return humanText === "" ? firstParagraph(plainBody) : humanText;
}

export function landingCommitMessage(view: PullRequestView): string {
  const subject = titleAfterDraftPrefixAndMarker(view.title).trim();
  const summary = pullRequestBodySummary(view.body);
  return summary === "" ? `${subject}\n` : `${subject}\n\n${summary}\n`;
}
