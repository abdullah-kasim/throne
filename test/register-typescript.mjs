import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { gateListedTestFile } from './heavy-tests-gate.ts';

if (process.argv[1]) gateListedTestFile(process.argv[1], process.cwd());

register('ts-node/esm/transpile-only', pathToFileURL('./'));
