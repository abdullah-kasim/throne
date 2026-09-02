import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { realUsageCacheIo } from './telemetry-core/cache.ts';
import { readUsageLogRaw, realAppendUsageLog } from './telemetry-core/log.ts';
import type { HttpJsonRequest, HttpJsonResponse, PlanUsageDeps } from './pipeline.types.ts';

const CREDENTIALS_PATH = path.join(homedir(), '.claude', '.credentials.json');

async function requestJson(request: HttpJsonRequest): Promise<HttpJsonResponse> {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  let json: unknown = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

function createRuntime(credentialsPath: string = CREDENTIALS_PATH): PlanUsageDeps {
  return {
    readCredentialsFile: () => readFile(credentialsPath, 'utf8'),
    httpJson: requestJson,
    now: () => new Date(),
    out: (line) => process.stdout.write(line),
    errOut: (line) => process.stderr.write(line),
    cacheIo: realUsageCacheIo(HARNESS_NAMES.CLAUDE),
    appendUsageLog: realAppendUsageLog(),
    readUsageLog: readUsageLogRaw,
  };
}

/** Owns the process, filesystem, network, and clock seams for plan usage. */
export class PlanUsagePlatformService {
  readonly runtime: PlanUsageDeps;

  constructor(runtime: PlanUsageDeps = createRuntime()) {
    this.runtime = runtime;
  }

  static forCredentialsPath(credentialsPath: string): PlanUsagePlatformService {
    return new PlanUsagePlatformService(createRuntime(credentialsPath));
  }
}
