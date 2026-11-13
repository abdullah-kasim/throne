import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReadOptions } from '../herdr/herdr-inventory.service.ts';
import { runAgentLogs } from './agent-logs.ts';

test("asking for a Stager's logs by hand still reads its history", async () => {
  const reads: { name: string; options: ReadOptions }[] = [];
  const writeToStandardOutput = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const exitCode = await runAgentLogs(['stager-north'], async (name, options) => {
      reads.push({ name, options });
      return 'the Stager pane\n';
    });
    assert.equal(exitCode, 0);
  } finally {
    process.stdout.write = writeToStandardOutput;
  }
  assert.deepEqual(reads.map((read) => [read.name, read.options.source]), [['stager-north', 'recent']]);
});
