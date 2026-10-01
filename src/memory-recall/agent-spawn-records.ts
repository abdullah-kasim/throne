import path from 'node:path';
import { LedgerDataService, REAPED_DIR_NAME } from '../agentdata/ledger-data.service.ts';
import { readSpawnSpec, type SpawnSpec } from '../agentdata/spawn-data-contracts.ts';

export interface AgentSpawnRecord {
  readonly name: string;
  readonly spawn: SpawnSpec;
}

const LEDGER_DATA = new LedgerDataService();

async function spawnRecordsIn(
  ledgerDirectory: string,
  agentNames: readonly string[],
): Promise<readonly AgentSpawnRecord[]> {
  const records = await Promise.all(
    agentNames.map(async (name) => ({ name, spawn: await readSpawnSpec(name, ledgerDirectory) })),
  );
  return records.filter((record): record is AgentSpawnRecord => record.spawn !== null);
}

export async function spawnRecordsOfEveryAgent(
  agentLedgerDirectory: string,
): Promise<readonly AgentSpawnRecord[]> {
  const [liveAgentNames, reapedAgentNames] = await Promise.all([
    LEDGER_DATA.listRegisteredAgents(agentLedgerDirectory),
    LEDGER_DATA.listReapedAgentNames(agentLedgerDirectory),
  ]);
  const [liveRecords, reapedRecords] = await Promise.all([
    spawnRecordsIn(agentLedgerDirectory, liveAgentNames),
    spawnRecordsIn(path.join(agentLedgerDirectory, REAPED_DIR_NAME), reapedAgentNames),
  ]);
  return [...liveRecords, ...reapedRecords];
}
