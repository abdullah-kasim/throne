export const MISSING_ASK = 'missing-ask';
export const BARE_NARROW_ASK = 'bare-narrow-ask';
export const KEPT_NARROW_TRIGGER = 'kept-narrow-trigger';
export const TOKEN_AREA = 'token-area';
export const BARE_REPOSITORY_NAME = 'bare-repository-name';
export const REPOSITORY_WIDE_NOUN = 'repository-wide-noun';
export const VERB_ENDING_FRAGMENT = 'verb-ending-fragment';
export const GENERAL_COMPUTING_TERM = 'general-computing-term';

export const ASK_LINT_RULES_IN_ORDER = [
  MISSING_ASK,
  BARE_NARROW_ASK,
  KEPT_NARROW_TRIGGER,
  TOKEN_AREA,
  BARE_REPOSITORY_NAME,
  REPOSITORY_WIDE_NOUN,
  VERB_ENDING_FRAGMENT,
  GENERAL_COMPUTING_TERM,
] as const;
export type AskLintRule = (typeof ASK_LINT_RULES_IN_ORDER)[number];

export const TRIGGER_LEAD_IN = 'That includes, but is not limited to:';

const HOUSE_FORMS = [
  /^Does the task touch (.+) in any way\?$/i,
  /^Does the task involve (.+)\?$/i,
  /^Is the task about (.+)\?$/i,
];
const FIRST_SENTENCE = /^(.*?[?!.])(?=\s+[A-Z]|\s*$)/s;
const LEADING_ARTICLE = /^(?:the|a|an)\s+/i;
const PARENTHETICAL = /\([^)]*\)/g;
const CONJUNCTION = /\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+/i;
const SURROUNDING_PUNCTUATION = /^[("'“‘]+|[)"'”’,;:!?]+$/g;
const POSSESSIVE_ENDING = /(?:'s|’s|'|’)$/;
const REPOSITORY_SUFFIXES = ['', ' repo', ' repository', ' codebase'];

const PATH_START = /^(?:~|\.{1,2})?\//;
const PATH_WITH_A_NAME = /\/.*[._-]|[._-].*\//;
const FILE_NAME_WITH_EXTENSION =
  /\.(?:md|ts|js|mjs|cjs|json|jsonl|sh|py|php|ya?ml|toml|txt|tsv|csv|html|css|sql|log|lock|env|conf|plist|service|timer)$/i;
const FLAG = /^--?[a-z]/i;
const CAMEL_CASE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
const SNAKE_CASE = /^\w+_\w+$/;
const LETTER_BESIDE_DIGIT = /[A-Za-z]\d|\d[A-Za-z]/;
const VERSION = /\d\.\d/;
const SCREAMING_WORD = /^[A-Z][A-Z0-9]+$/;
const BACKTICK = '`';

const COMMAND_WORDS = new Set([
  'npm', 'npx', 'node', 'git', 'gh', 'make', 'docker', 'podman', 'throne', 'curl',
  'brew', 'yarn', 'pnpm', 'kubectl', 'launchctl', 'systemctl',
]);

const SUBCOMMANDS = new Set([
  'run', 'test', 'install', 'build', 'start', 'exec', 'commit', 'push', 'pull', 'fetch', 'merge', 'rebase',
  'clone', 'checkout', 'log', 'diff', 'reset', 'stash', 'pr', 'api', 'up', 'down', 'compose', 'send-agent',
]);

const REPOSITORY_WIDE_NOUNS = new Set([
  'repository', 'repo', 'branch', 'commit', 'pr', 'pull request', 'worktree', 'agent', 'alpha',
  'shadow', 'stager', 'regent', 'campaign', 'slice', 'row', 'trunk', 'main',
]);

const PREPOSITIONS = new Set([
  'of', 'in', 'on', 'for', 'to', 'from', 'with', 'at', 'by', 'about', 'into', 'through', 'under',
  'over', 'between', 'across', 'around', 'via', 'per', 'after', 'before', 'during', 'within', 'without',
]);

const FINITE_VERBS = new Set([
  'needs', 'picks', 'refuses', 'sees', 'dies', 'die', 'fails', 'breaks', 'hangs', 'pushes', 'clears',
  'crashes', 'stalls', 'ignores', 'rejects', 'loses', 'forgets', 'overwrites', 'swallows', 'skips',
]);

const MODALS_AUXILIARIES_AND_NEGATIONS = new Set([
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'do', 'does', 'did',
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'never', 'not', 'cannot', "can't", "don't",
  "doesn't", "didn't", "won't",
]);

const GENERAL_COMPUTING_TERMS = new Set([
  'env vars', 'environment variables', 'file paths', 'paths', 'test fixtures', 'fixtures', 'markdown',
  'json', 'yaml', 'html', 'css', 'config', 'configuration', 'config files', 'logs', 'log files', 'tests',
  'unit tests', 'scripts', 'shell scripts', 'shell', 'terminal', 'dependencies', 'errors', 'error handling',
  'timeouts', 'network', 'networking', 'filesystem', 'file system', 'files', 'directories', 'permissions',
  'database', 'databases', 'cache', 'caching', 'types', 'regex', 'regular expressions', 'strings', 'api',
  'apis', 'cli', 'command line', 'code', 'comments', 'code comments', 'documentation', 'docs', 'builds',
  'linting', 'formatting', 'typescript', 'javascript', 'git', 'npm', 'docker', 'containers', 'processes',
  'secrets', 'urls',
]);

interface SplitAsk {
  readonly firstSentence: string;
  readonly rest: string;
}

function splitFirstSentence(ask: string): SplitAsk {
  const match = FIRST_SENTENCE.exec(ask);
  const firstSentence = match?.[1] ?? ask;
  return { firstSentence: firstSentence.trim(), rest: ask.slice(firstSentence.length).trim() };
}

function areaOfAsk(firstSentence: string): string | undefined {
  for (const houseForm of HOUSE_FORMS) {
    const area = houseForm.exec(firstSentence)?.[1]?.trim();
    if (area !== undefined && area.length > 0) return area;
  }
  return undefined;
}

function wordsOf(phrase: string): readonly string[] {
  return phrase
    .split(/\s+/)
    .map((word) => word.replace(SURROUNDING_PUNCTUATION, ''))
    .filter((word) => word.length > 0);
}

function withoutLeadingArticle(phrase: string): string {
  return phrase.trim().replace(LEADING_ARTICLE, '');
}

function withoutPossessive(word: string): string {
  return word.replace(POSSESSIVE_ENDING, '');
}

function isPath(word: string): boolean {
  return PATH_START.test(word) || (word.includes('/') && PATH_WITH_A_NAME.test(word));
}

function isCodeToken(word: string): boolean {
  const bareWord = withoutPossessive(word);
  return (
    isPath(bareWord) ||
    FILE_NAME_WITH_EXTENSION.test(bareWord) ||
    FLAG.test(bareWord) ||
    CAMEL_CASE.test(bareWord) ||
    SNAKE_CASE.test(bareWord) ||
    LETTER_BESIDE_DIGIT.test(bareWord) ||
    VERSION.test(bareWord)
  );
}

function isCommandLine(words: readonly string[]): boolean {
  return COMMAND_WORDS.has(words[0] ?? '') && SUBCOMMANDS.has(words[1] ?? '');
}

function namesACodeToken(area: string): boolean {
  const words = wordsOf(withoutLeadingArticle(area));
  const isOneScreamingWord = words.length === 1 && SCREAMING_WORD.test(words[0] as string);
  return area.includes(BACKTICK) || words.some(isCodeToken) || isCommandLine(words) || isOneScreamingWord;
}

function isBareRepositoryName(area: string, repositoryName: string): boolean {
  const lowercaseArea = withoutLeadingArticle(area).toLowerCase();
  const lowercaseName = repositoryName.toLowerCase();
  return REPOSITORY_SUFFIXES.some((suffix) => lowercaseArea === `${lowercaseName}${suffix}`);
}

function conjunctsOf(area: string): readonly string[] {
  return area
    .replace(PARENTHETICAL, ' ')
    .split(CONJUNCTION)
    .map((conjunct) => conjunct.trim())
    .filter((conjunct) => conjunct.length > 0);
}

function singularOf(word: string): string {
  if (REPOSITORY_WIDE_NOUNS.has(word)) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ches') || word.endsWith('shes')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function headNounCandidatesOf(conjunct: string): readonly string[] {
  const words = wordsOf(conjunct).map((word) => withoutPossessive(word).toLowerCase());
  const prepositionIndex = words.findIndex((word, index) => index > 0 && PREPOSITIONS.has(word));
  const nounPhrase = prepositionIndex === -1 ? words : words.slice(0, prepositionIndex);
  const head = singularOf(nounPhrase.at(-1) ?? '');
  const wordBeforeHead = nounPhrase.at(-2);
  return wordBeforeHead === undefined ? [head] : [head, `${wordBeforeHead} ${head}`];
}

function hasARepositoryWideHeadNoun(area: string): boolean {
  return conjunctsOf(area).some((conjunct) =>
    headNounCandidatesOf(conjunct).some((candidate) => REPOSITORY_WIDE_NOUNS.has(candidate)),
  );
}

function endsOnAVerb(conjunct: string): boolean {
  const words = wordsOf(conjunct).map((word) => word.toLowerCase());
  const lastWord = words.at(-1) ?? '';
  const wordBeforeLast = words.at(-2);
  return (
    FINITE_VERBS.has(lastWord) ||
    (wordBeforeLast !== undefined && MODALS_AUXILIARIES_AND_NEGATIONS.has(wordBeforeLast))
  );
}

function isAVerbEndingFragment(area: string): boolean {
  return conjunctsOf(area).some(endsOnAVerb);
}

function isAGeneralComputingTerm(area: string): boolean {
  return GENERAL_COMPUTING_TERMS.has(withoutLeadingArticle(area).toLowerCase());
}

function areaViolationsOf(area: string, repositoryName: string | undefined): readonly AskLintRule[] {
  const violations: AskLintRule[] = [];
  if (namesACodeToken(area)) violations.push(TOKEN_AREA);
  if (repositoryName !== undefined && isBareRepositoryName(area, repositoryName)) {
    violations.push(BARE_REPOSITORY_NAME);
  }
  if (hasARepositoryWideHeadNoun(area)) violations.push(REPOSITORY_WIDE_NOUN);
  if (isAVerbEndingFragment(area)) violations.push(VERB_ENDING_FRAGMENT);
  if (isAGeneralComputingTerm(area)) violations.push(GENERAL_COMPUTING_TERM);
  return violations;
}

export function askViolationsOf(
  ask: string | undefined,
  repositoryName: string | undefined,
): readonly AskLintRule[] {
  if (ask === undefined || ask.trim().length === 0) return [MISSING_ASK];
  const { firstSentence, rest } = splitFirstSentence(ask.trim());
  const area = areaOfAsk(firstSentence);
  const violations: AskLintRule[] = [];
  if (area === undefined) violations.push(BARE_NARROW_ASK);
  if (rest.length > 0 && !rest.startsWith(TRIGGER_LEAD_IN)) violations.push(KEPT_NARROW_TRIGGER);
  if (area !== undefined) violations.push(...areaViolationsOf(area, repositoryName));
  return violations;
}
