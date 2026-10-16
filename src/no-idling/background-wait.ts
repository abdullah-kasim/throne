import { lastMessageBlock, liveBackgroundWork } from './idle-pane-tag-classification.ts';

const WAITING_PHRASE =
  /\b(?:waiting[ \t]+(?:on|for)|queued|still[ \t]+running|when[ \t]+(?:it|they)[ \t]+(?:reports?|finish(?:es)?))\b/i;
const BACKGROUND_SUBJECT = /\b(?:runs?|suites?|monitors?|shells?|background[ \t]+agents?)\b/i;
const SENTENCE_END = /(?<=[.!?])\s+/;
const TRAILING_SENTENCE_PUNCTUATION = /[.!?]+$/;

function saysItWaitsOnBackgroundWork(sentence: string): boolean {
  return WAITING_PHRASE.test(sentence) && BACKGROUND_SUBJECT.test(sentence);
}

export function waitingSentenceInMessage(message: string): string | undefined {
  const sentence = message
    .replace(/\s+/g, ' ')
    .trim()
    .split(SENTENCE_END)
    .find(saysItWaitsOnBackgroundWork);
  return sentence?.replace(TRAILING_SENTENCE_PUNCTUATION, '');
}

export function backgroundWorkThePaneWaitsOn(output: string): string | undefined {
  return liveBackgroundWork(output) ?? waitingSentenceInMessage(lastMessageBlock(output));
}

async function readWhatTheAgentWaitsOn(
  name: string,
  readPane: (name: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    return backgroundWorkThePaneWaitsOn(await readPane(name));
  } catch {
    return undefined;
  }
}

export async function withWhatEachAgentWaitsOn<Listed extends { readonly agent: string }>(
  listed: readonly Listed[],
  readPane: (name: string) => Promise<string>,
): Promise<(Listed & { readonly backgroundWork?: string })[]> {
  const described: (Listed & { readonly backgroundWork?: string })[] = [];
  for (const entry of listed) {
    const backgroundWork = await readWhatTheAgentWaitsOn(entry.agent, readPane);
    described.push(backgroundWork === undefined ? entry : { ...entry, backgroundWork });
  }
  return described;
}
