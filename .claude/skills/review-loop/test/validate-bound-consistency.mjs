#!/usr/bin/env node
// Proves SKILL.md never states two contradicting numbers for the same named
// bound (e.g. "cap 5" in one place and "cap 3" in another for the same
// concept) — every mention of a tracked concept must agree.
//
// usage: node validate-bound-consistency.mjs <SKILL.md>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

// Each concept's regex captures the number attached to every mention of
// that named bound anywhere in SKILL.md. Add a concept here whenever the
// skill states a new numeric bound.
const CONCEPTS = [
  { label: 'proposed fixer-name length cap', pattern: /(?:≤|<=)\s*(\d+)\s*characters?/gi },
  { label: 'quota-unknown retry attempts', pattern: /(\d+)\s*attempts?/gi },
  { label: 'quota-source HTTP error status', pattern: /HTTP\s*(\d+)/gi },
];

export function findContradictions(skillText) {
  const contradictions = [];
  for (const { label, pattern } of CONCEPTS) {
    const values = new Set([...skillText.matchAll(pattern)].map((m) => m[1]));
    if (values.size > 1) {
      contradictions.push(`"${label}" states contradicting numbers: ${[...values].join(' vs ')}`);
    }
  }
  return contradictions;
}

async function main() {
  const [skillPath] = process.argv.slice(2);
  if (!skillPath) {
    console.error('usage: validate-bound-consistency.mjs <SKILL.md>');
    process.exitCode = 2;
    return;
  }

  const skillText = await readFile(skillPath, 'utf8');
  const contradictions = findContradictions(skillText);
  if (contradictions.length > 0) {
    for (const c of contradictions) console.error(`bound-consistency: ${c}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
