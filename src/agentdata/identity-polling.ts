import { createRequire } from "node:module";
import type Parser from "tree-sitter";
const LOOP_NODE_TYPES = [
  "while_statement",
  "for_statement",
  "c_style_for_statement",
];
const TIMER_EXECUTABLES = new Set(["sleep", "usleep"]);
const SUPERVISION_QUERIES = new Set(["agent-logs", "agent-statuses"]);
const EXECUTABLE_WRAPPERS = new Set(["command", "builtin", "env"]);
const SCRIPT_EXECUTABLES = new Set(["node", "bun", "deno", "tsx"]);
const THRONE_TOOL_ENTRYPOINTS = new Set([
  "./tools.ts",
  "src/tools.ts",
  "./src/tools.ts",
]);
// Agents are told to invoke the PATH-resolved `throne` so they never have to
// `cd` out of their own worktree; the relative forms stay recognised because
// the Regent and older prompts still use `./bin/throne`, and callers
// migrated to the split CLI entrypoint use `./bin/throne-cli`. All three must
// match, or the supervision-polling guard goes blind to whichever spelling
// it omits.
const THRONE_CLI_EXECUTABLES = new Set([
  "throne",
  "./bin/throne",
  "./bin/throne-cli",
]);
const ENV_SHORT_OPTIONS = new Set(["0", "i", "v"]);
const ENV_SHORT_OPTIONS_WITH_OPERAND = new Set(["a", "C", "S", "u"]);
const ENV_LONG_OPTIONS = new Set([
  "--debug",
  "--ignore-environment",
  "--list-signal-handling",
  "--null",
]);
const ENV_LONG_OPTIONS_WITH_OPERAND = new Set([
  "--argv0",
  "--unset",
  "--chdir",
  "--split-string",
]);
const ENV_LONG_OPTIONS_WITH_OPTIONAL_OPERAND = new Set([
  "--block-signal",
  "--default-signal",
  "--ignore-signal",
]);
const STATIC_WORD_TYPES = new Set([
  "word",
  "number",
  "raw_string",
  "string",
  "concatenation",
  "command_name",
]);

const require = createRequire(import.meta.url);
let parser: Parser | undefined;

function bashParser(): Parser {
  if (parser !== undefined) {
    return parser;
  }
  const ParserConstructor = require("tree-sitter") as typeof Parser;
  const bash = require("tree-sitter-bash") as Parser.Language;
  parser = new ParserConstructor();
  parser.setLanguage(bash);
  return parser;
}

function removeBackslashEscapes(value: string): string {
  let normalized = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
    }
    normalized += value[index];
  }
  return normalized;
}

function staticWord(node: Parser.SyntaxNode): string | undefined {
  if (!STATIC_WORD_TYPES.has(node.type)) {
    return undefined;
  }
  if (node.type === "word" || node.type === "number") {
    return removeBackslashEscapes(node.text);
  }
  if (node.type === "raw_string") {
    return node.text.slice(1, -1);
  }
  if (node.type === "command_name") {
    const child = node.namedChildren[0];
    return child === undefined ? undefined : staticWord(child);
  }
  let value = "";
  for (const child of node.namedChildren) {
    if (child.type === "string_content") {
      value += removeBackslashEscapes(child.text);
      continue;
    }
    const fragment = staticWord(child);
    if (fragment === undefined) {
      return undefined;
    }
    value += fragment;
  }
  return value;
}

function commandWords(command: Parser.SyntaxNode): string[] {
  const words: string[] = [];
  for (const child of command.namedChildren) {
    if (child.type === "variable_assignment") {
      continue;
    }
    const value = staticWord(child);
    if (value === undefined) {
      break;
    }
    words.push(value);
  }
  return words;
}

function isAssignment(value: string): boolean {
  return /^[a-z_][a-z0-9_]*=/i.test(value);
}

function skipCommandWrapperOptions(words: string[], start: number): number {
  let index = start;
  while (index < words.length && words[index].startsWith("-")) {
    index += 1;
  }
  return index;
}

function envShortOptionLength(word: string): number | undefined {
  if (word === "-") {
    return 1;
  }
  for (let index = 1; index < word.length; index += 1) {
    const option = word[index];
    if (ENV_SHORT_OPTIONS.has(option)) {
      continue;
    }
    if (ENV_SHORT_OPTIONS_WITH_OPERAND.has(option)) {
      return index + 1 === word.length ? 2 : 1;
    }
    return undefined;
  }
  return 1;
}

function envLongOptionLength(word: string): number | undefined {
  if (ENV_LONG_OPTIONS.has(word)) {
    return 1;
  }
  for (const option of ENV_LONG_OPTIONS_WITH_OPERAND) {
    if (word === option) {
      return 2;
    }
    if (word.startsWith(`${option}=`)) {
      return 1;
    }
  }
  for (const option of ENV_LONG_OPTIONS_WITH_OPTIONAL_OPERAND) {
    if (word === option || word.startsWith(`${option}=`)) {
      return 1;
    }
  }
  return undefined;
}

function envOptionLength(word: string): number | undefined {
  return word.startsWith("--")
    ? envLongOptionLength(word)
    : envShortOptionLength(word);
}

function splitEnvString(value: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let wordStarted = false;

  const finishWord = (): void => {
    if (wordStarted) {
      words.push(word);
      word = "";
      wordStarted = false;
    }
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "" && /\s/.test(character)) {
      finishWord();
      continue;
    }
    if (quote === "" && character === "#" && !wordStarted) {
      break;
    }
    if (character === '"' || character === "'") {
      if (quote === "") {
        quote = character;
        wordStarted = true;
        continue;
      }
      if (quote === character) {
        quote = "";
        continue;
      }
    }
    if (character === "$") {
      return undefined;
    }
    if (character !== "\\") {
      word += character;
      wordStarted = true;
      continue;
    }

    index += 1;
    if (index === value.length) {
      return undefined;
    }
    const escaped = value[index];
    if (escaped === "c") {
      finishWord();
      return quote === "" ? words : undefined;
    }
    if (escaped === "_") {
      if (quote === "") {
        finishWord();
      } else {
        word += " ";
        wordStarted = true;
      }
      continue;
    }
    const escapeValues: Readonly<Record<string, string>> = {
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "#": "#",
      $: "$",
      '"': '"',
      "'": "'",
      "\\": "\\",
    };
    const escapedValue = escapeValues[escaped];
    if (escapedValue === undefined) {
      return undefined;
    }
    word += escapedValue;
    wordStarted = true;
  }

  if (quote !== "") {
    return undefined;
  }
  finishWord();
  return words;
}

function envSplitString(
  word: string,
  followingWord: string | undefined,
): { consumed: number; words: string[] } | undefined {
  let operand: string | undefined;
  let consumed = 1;
  if (word === "--split-string" || /^(?:-[0iv]*S)$/.test(word)) {
    operand = followingWord;
    consumed = 2;
  } else if (word.startsWith("--split-string=")) {
    operand = word.slice("--split-string=".length);
  } else {
    const short = word.match(/^(?:-[0iv]*S)(.+)$/);
    operand = short?.[1];
  }
  if (operand === undefined) {
    return undefined;
  }
  const words = splitEnvString(operand);
  return words === undefined ? undefined : { consumed, words };
}

function envExecutableWords(words: string[], start: number): string[] {
  const expandedWords = [...words];
  let index = start;
  let optionsEnded = false;
  while (index < expandedWords.length) {
    const word = expandedWords[index];
    if (isAssignment(word)) {
      index += 1;
      continue;
    }
    if (word === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }
    if (optionsEnded || !word.startsWith("-")) {
      return expandedWords.slice(index);
    }
    if (
      word === "--split-string" ||
      word.startsWith("--split-string=") ||
      /^(?:-[0iv]*S)/.test(word)
    ) {
      const split = envSplitString(word, expandedWords[index + 1]);
      if (split === undefined || split.words.length === 0) {
        return [];
      }
      expandedWords.splice(index, split.consumed, ...split.words);
      continue;
    }
    const optionLength = envOptionLength(word);
    if (
      optionLength === undefined ||
      index + optionLength > expandedWords.length
    ) {
      return [];
    }
    index += optionLength;
  }
  return [];
}

function wrappedExecutableWords(
  words: string[],
  wrapperIndex: number,
): string[] {
  return words[wrapperIndex] === "env"
    ? envExecutableWords(words, wrapperIndex + 1)
    : words.slice(skipCommandWrapperOptions(words, wrapperIndex + 1));
}

function executedWords(command: Parser.SyntaxNode): string[] {
  let words = commandWords(command);
  while (words.length > 0 && EXECUTABLE_WRAPPERS.has(words[0])) {
    words = wrappedExecutableWords(words, 0);
  }
  return words;
}

function commandIsTimer(command: Parser.SyntaxNode): boolean {
  const words = executedWords(command);
  if (words.length === 0) {
    return false;
  }
  const executable = words[0];
  return (
    TIMER_EXECUTABLES.has(executable) ||
    (executable === "read" &&
      words.slice(1).some((word) => word === "-t" || word.startsWith("-t")))
  );
}

function commandIsSupervisionQuery(command: Parser.SyntaxNode): boolean {
  const words = executedWords(command);
  if (words.length === 0) {
    return false;
  }
  if (THRONE_CLI_EXECUTABLES.has(words[0])) {
    return words.length >= 2 && SUPERVISION_QUERIES.has(words[1]);
  }
  if (words.length < 3 || !SCRIPT_EXECUTABLES.has(words[0])) {
    return false;
  }
  return (
    THRONE_TOOL_ENTRYPOINTS.has(words[1]) && SUPERVISION_QUERIES.has(words[2])
  );
}

function loopContainsPolling(loop: Parser.SyntaxNode): boolean {
  const body = loop.childForFieldName("body");
  if (body === null) {
    return false;
  }
  const commands = body.descendantsOfType("command");
  return (
    commands.some(commandIsTimer) && commands.some(commandIsSupervisionQuery)
  );
}

export function containsSupervisionPollingLoop(instruction: string): boolean {
  const tree = bashParser().parse(instruction);
  return tree.rootNode
    .descendantsOfType(LOOP_NODE_TYPES)
    .some(loopContainsPolling);
}
