import {
  NO,
  YES,
  type BackendAnswer,
  type ClassifierBackend,
  type ClassifierQuestion,
  type ClassifierState,
  type YesOrNoRule,
} from './classifier.types.ts';

const SHORTEST_MEANINGFUL_WORD_LENGTH = 3;

const WORDS_TOO_COMMON_TO_MATCH_ON = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
  'does', 'did', 'has', 'have', 'had', 'was', 'were', 'will', 'with',
  'this', 'that', 'these', 'those', 'then', 'than', 'them', 'they',
  'from', 'into', 'onto', 'over', 'under', 'about', 'after', 'before',
  'when', 'where', 'which', 'while', 'what', 'who', 'why', 'how',
  'its', 'his', 'her', 'our', 'your', 'their', 'out', 'off', 'use',
  'task', 'work', 'make', 'need', 'want', 'please', 'should', 'would',
  'could', 'must', 'may', 'might', 'also', 'just', 'only', 'more',
  'some', 'such', 'very', 'via', 'per', 'one', 'two', 'now', 'new',
  'get', 'got', 'let', 'run', 'see', 'look', 'being', 'been', 'involve',
  'involves', 'agent', 'file', 'files', 'code', 'thing', 'there', 'here',
]);

function withoutPluralEnding(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}

export function meaningfulWords(text: string): ReadonlySet<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(
      (word) =>
        word.length >= SHORTEST_MEANINGFUL_WORD_LENGTH &&
        !WORDS_TOO_COMMON_TO_MATCH_ON.has(word),
    )
    .map(withoutPluralEnding);
  return new Set(words);
}

export function countSharedMeaningfulWords(
  state: string,
  questionText: string,
): number {
  const stateWords = meaningfulWords(state);
  let sharedWordCount = 0;
  for (const word of meaningfulWords(questionText)) {
    if (stateWords.has(word)) sharedWordCount += 1;
  }
  return sharedWordCount;
}

export function containsAnyPhrase(
  state: string,
  phrases: readonly string[],
): boolean {
  const lowercaseState = state.toLowerCase();
  return phrases.some(
    (phrase) =>
      phrase.trim().length > 0 &&
      lowercaseState.includes(phrase.trim().toLowerCase()),
  );
}

function probabilityOfYes(state: string, rule: YesOrNoRule): number {
  if (rule.kind === 'any-phrase') {
    return containsAnyPhrase(state, rule.phrases) ? 1 : 0;
  }
  return Math.min(
    1,
    countSharedMeaningfulWords(state, rule.text) / rule.sharedWordsForCertainty,
  );
}

export function textTheQuestionIsAbout(
  state: ClassifierState,
  question: ClassifierQuestion,
): string {
  if (typeof state === 'string') return state;
  return question.stateField === undefined
    ? Object.values(state).join('\n')
    : (state[question.stateField] ?? '');
}

function answerByRule(
  state: ClassifierState,
  question: ClassifierQuestion,
): BackendAnswer {
  const yesProbability = probabilityOfYes(
    textTheQuestionIsAbout(state, question),
    question.yesOrNoRule,
  );
  return yesProbability >= 0.5
    ? { questionId: question.id, pick: YES, probability: yesProbability }
    : { questionId: question.id, pick: NO, probability: 1 - yesProbability };
}

export const RULES_BACKEND: ClassifierBackend = {
  name: 'rules',
  answer: (state, questions) =>
    Promise.resolve(
      questions.map((question) => answerByRule(state, question)),
    ),
};
