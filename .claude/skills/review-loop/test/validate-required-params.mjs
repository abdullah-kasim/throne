#!/usr/bin/env node
// Proves review-loop's Input contract states TWO distinct named refusals —
// one for a missing OBJECTIVE/TARGET_REPO, one for a missing
// REVIEWER_MODEL/REVIEWER_EFFORT — not one generic "missing input" message.
//
// usage: node validate-required-params.mjs <SKILL.md>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const REFUSAL_MESSAGE = /"review-loop: missing[^"]*"/g;

export function validateRequiredParams(skillText) {
  const errors = [];
  const messages = [...new Set([...skillText.matchAll(REFUSAL_MESSAGE)].map((m) => m[0]))];

  const objectiveMessages = messages.filter((m) => /OBJECTIVE/.test(m));
  const reviewerMessages = messages.filter((m) => /REVIEWER_MODEL|REVIEWER_EFFORT/.test(m));

  if (objectiveMessages.length === 0) {
    errors.push('no distinct refusal message naming missing OBJECTIVE/TARGET_REPO');
  }
  if (reviewerMessages.length === 0) {
    errors.push('no distinct refusal message naming missing REVIEWER_MODEL/REVIEWER_EFFORT');
  }
  if (
    objectiveMessages.length > 0 &&
    reviewerMessages.length > 0 &&
    objectiveMessages.some((om) => reviewerMessages.includes(om))
  ) {
    errors.push('the OBJECTIVE refusal and the REVIEWER_MODEL refusal are the same generic message, not two distinct ones');
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const [skillPath] = process.argv.slice(2);
  if (!skillPath) {
    console.error('usage: validate-required-params.mjs <SKILL.md>');
    process.exitCode = 2;
    return;
  }

  const skillText = await readFile(skillPath, 'utf8');
  const result = validateRequiredParams(skillText);
  if (!result.ok) {
    for (const error of result.errors) console.error(`required-params: ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
