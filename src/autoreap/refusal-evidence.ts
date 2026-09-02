import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RUNTIME_DATA_DIR } from '../shared-policy/runtime-data-home.ts';

const EVIDENCE_DIR = path.join(RUNTIME_DATA_DIR, 'autoreap');
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, 'claimed-but-refused.json');

interface RefusalEvidence {
  readonly agents: Record<string, { readonly refusedAt: string; readonly reason: string }>;
}

function readEvidence(): RefusalEvidence {
  try {
    const parsed = JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) as RefusalEvidence;
    return parsed?.agents && typeof parsed.agents === 'object' ? parsed : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

export function recordClaimedButRefused(agent: string, reason: string): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const evidence = readEvidence();
  const next: RefusalEvidence = {
    agents: { ...evidence.agents, [agent]: { refusedAt: new Date().toISOString(), reason } },
  };
  const temporary = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, EVIDENCE_PATH);
}

export function clearClaimedButRefused(agent: string): void {
  const evidence = readEvidence();
  if (!(agent in evidence.agents)) return;
  const agents = { ...evidence.agents };
  delete agents[agent];
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const temporary = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ agents }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, EVIDENCE_PATH);
}

export function readClaimedButRefusedAgentNames(): ReadonlySet<string> {
  return new Set(Object.keys(readEvidence().agents));
}
