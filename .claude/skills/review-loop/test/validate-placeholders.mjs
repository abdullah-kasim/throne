#!/usr/bin/env node
// Proves every {{TOKEN}} placeholder used in templates/*.md is declared in
// SKILL.md's "## Template rendering contract" table, and every declared
// token is actually used somewhere in the templates — no undeclared token,
// no declared-but-unused token.
//
// usage: node validate-placeholders.mjs <SKILL.md> <templates-dir>

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const RENDERING_CONTRACT_SECTION = /## Template rendering contract\n([\s\S]*?)(?:\n## |$)/;
const FENCED_CODE_BLOCK = /```[\s\S]*?```/g;
// SKILL.md uses the literal `{{TOKEN}}` once as generic prose describing the
// placeholder syntax itself ("these exact {{TOKEN}} interfaces") — that is
// not a declared field and must not be mistaken for one.
const GENERIC_TOKEN_SYNTAX_MENTION = /`\{\{TOKEN\}\}`/g;

function tokensIn(text) {
  return new Set([...text.matchAll(TOKEN)].map((m) => m[1]));
}

export function declaredTokens(skillText) {
  const section = RENDERING_CONTRACT_SECTION.exec(skillText);
  if (!section) {
    throw new Error('SKILL.md has no "## Template rendering contract" section');
  }
  // The section includes a bash code-fence illustrating the placeholder
  // regex itself — that's a pattern, not a declared token, so strip fences
  // before extracting {{TOKEN}} occurrences.
  const withoutCode = section[1]
    .replace(FENCED_CODE_BLOCK, '')
    .replace(GENERIC_TOKEN_SYNTAX_MENTION, '');
  return tokensIn(withoutCode);
}

export async function usedTokens(templatesDir) {
  const files = (await readdir(templatesDir)).filter((f) => f.endsWith('.md'));
  const used = new Set();
  for (const file of files) {
    const text = await readFile(path.join(templatesDir, file), 'utf8');
    for (const token of tokensIn(text)) used.add(token);
  }
  return used;
}

export function diffTokenSets(declared, used) {
  const undeclared = [...used].filter((t) => !declared.has(t)).sort();
  const unused = [...declared].filter((t) => !used.has(t)).sort();
  return { undeclared, unused };
}

async function main() {
  const [skillPath, templatesDir] = process.argv.slice(2);
  if (!skillPath || !templatesDir) {
    console.error('usage: validate-placeholders.mjs <SKILL.md> <templates-dir>');
    process.exitCode = 2;
    return;
  }

  const skillText = await readFile(skillPath, 'utf8');
  let declared;
  try {
    declared = declaredTokens(skillText);
  } catch (err) {
    console.error(`placeholders: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const used = await usedTokens(templatesDir);
  const { undeclared, unused } = diffTokenSets(declared, used);

  if (undeclared.length > 0) {
    console.error(`placeholders: templates use undeclared token(s): ${undeclared.join(', ')}`);
  }
  if (unused.length > 0) {
    console.error(`placeholders: rendering contract declares unused token(s): ${unused.join(', ')}`);
  }
  if (undeclared.length > 0 || unused.length > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
