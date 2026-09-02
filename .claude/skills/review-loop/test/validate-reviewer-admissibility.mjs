#!/usr/bin/env node
// Proves the role-pool admissibility predicate SKILL.md documents is
// actually checkable: fed a `list-harnesses-and-models`-shaped registry, it
// refuses a model in no role pool and accepts a model that is admitted.
//
// usage: node validate-reviewer-admissibility.mjs <registry.json> <reviewerModel> --expect=admit|refuse

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROLE_POOLS = ['Alpha', 'Shadow', 'ShadowSlice99'];

// Mirrors SKILL.md "Pre-flight gate — 1. Reviewer role-pool admissibility":
// REVIEWER_MODEL (with its harness) must appear in at least one of
// active_plan.rolePools.{Alpha,Shadow,ShadowSlice99}.
export function isReviewerAdmitted(registry, reviewerModel) {
  const rolePools = registry?.active_plan?.rolePools;
  if (!rolePools || typeof rolePools !== 'object') {
    throw new Error('registry has no active_plan.rolePools — malformed list-harnesses-and-models fixture');
  }
  return ROLE_POOLS.some((pool) => Array.isArray(rolePools[pool]) && rolePools[pool].includes(reviewerModel));
}

async function main() {
  const [registryPath, reviewerModel, expectArg] = process.argv.slice(2);
  const expect = (expectArg || '').replace(/^--expect=/, '');
  if (!registryPath || !reviewerModel || (expect !== 'admit' && expect !== 'refuse')) {
    console.error('usage: validate-reviewer-admissibility.mjs <registry.json> <reviewerModel> --expect=admit|refuse');
    process.exitCode = 2;
    return;
  }

  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  let admitted;
  try {
    admitted = isReviewerAdmitted(registry, reviewerModel);
  } catch (err) {
    console.error(`reviewer-admissibility: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const wantAdmit = expect === 'admit';
  if (admitted !== wantAdmit) {
    console.error(
      `reviewer-admissibility: expected ${reviewerModel} to be ${expect === 'admit' ? 'admitted' : 'refused'}, ` +
        `but the predicate says it is ${admitted ? 'admitted' : 'refused'}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
