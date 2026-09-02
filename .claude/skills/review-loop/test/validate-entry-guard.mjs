#!/usr/bin/env node
// Proves review-loop's SKILL.md reuses the canonical entry guard from
// execute-todos/SKILL.md instead of pasting a second copy of the resolver.
//
// usage: node validate-entry-guard.mjs <SKILL.md>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CANONICAL_REFERENCE = /execute-todos\/SKILL\.md/;
const ENTRY_GUARD_SECTION = /Entry guard/;
const DUPLICATED_RESOLVER_BODY = /throne_from\s*\(\)\s*\{/;

export function validateEntryGuard(skillText) {
  const errors = [];

  if (!CANONICAL_REFERENCE.test(skillText)) {
    errors.push('SKILL.md does not reference execute-todos/SKILL.md — the canonical entry-guard source');
  }
  if (!ENTRY_GUARD_SECTION.test(skillText)) {
    errors.push('SKILL.md contains no "Entry guard" section reference');
  }
  if (DUPLICATED_RESOLVER_BODY.test(skillText)) {
    errors.push('SKILL.md pastes a second throne_from() resolver body instead of reusing the canonical one');
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const [skillPath] = process.argv.slice(2);
  if (!skillPath) {
    console.error('usage: validate-entry-guard.mjs <SKILL.md>');
    process.exitCode = 2;
    return;
  }

  const skillText = await readFile(skillPath, 'utf8');
  const result = validateEntryGuard(skillText);
  if (!result.ok) {
    for (const error of result.errors) console.error(`entry-guard: ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
