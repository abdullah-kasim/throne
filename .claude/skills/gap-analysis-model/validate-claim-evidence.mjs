#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const CLAIM_BLOCK = /<!-- capability-claim:start -->([\s\S]*?)<!-- capability-claim:end -->/g;
const FIELD = /^([a-z-]+):\s*(.+)$/gm;

function parseFields(body) {
  return new Map([...body.matchAll(FIELD)].map((match) => [match[1], match[2].trim()]));
}

export async function validateCapabilityClaims(guidance, evidencePaths) {
  const allowedEvidence = new Map();
  for (const evidencePath of evidencePaths) {
    const absolutePath = path.resolve(evidencePath);
    allowedEvidence.set(absolutePath, await readFile(absolutePath, 'utf8'));
  }

  const blocks = [...guidance.matchAll(CLAIM_BLOCK)];
  if (blocks.length === 0) {
    return { ok: false, errors: ['no capability claim blocks found'] };
  }

  const errors = [];
  for (const [index, block] of blocks.entries()) {
    const fields = parseFields(block[1]);
    const statement = fields.get('statement');
    const evidenceFile = fields.get('evidence-file');
    const evidenceText = fields.get('evidence-text');
    const label = `claim ${index + 1}`;

    if (!statement) errors.push(`${label}: missing statement`);
    if (!evidenceFile) errors.push(`${label}: missing evidence-file`);
    if (!evidenceText) errors.push(`${label}: missing evidence-text`);
    if (!evidenceFile || !evidenceText) continue;

    const absoluteEvidenceFile = path.resolve(evidenceFile);
    const evidence = allowedEvidence.get(absoluteEvidenceFile);
    if (evidence === undefined) {
      errors.push(`${label}: evidence-file is outside the four campaign artifacts: ${evidenceFile}`);
    } else if (!evidence.includes(evidenceText)) {
      errors.push(`${label}: evidence-text is not present in ${evidenceFile}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

async function main() {
  const [guidancePath, ...evidencePaths] = process.argv.slice(2);
  if (!guidancePath || evidencePaths.length !== 4) {
    console.error('usage: validate-claim-evidence.mjs <guidance.md> <A-WORKLOG> <A-RESULT> <B-WORKLOG> <B-RESULT>');
    process.exitCode = 2;
    return;
  }

  const result = await validateCapabilityClaims(
    await readFile(guidancePath, 'utf8'),
    evidencePaths,
  );
  if (!result.ok) {
    for (const error of result.errors) console.error(`claim accuracy: ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  await main();
}
