import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readClaudeCredentialsRaw } from './claude-credential-source.ts';
import { accountUsageCacheFile } from './account-usage-cache.ts';
import { readUsageLogRaw, realAppendUsageLog } from './telemetry-core/log.ts';
import type { HttpJsonRequest, HttpJsonResponse, PlanUsageDeps } from './pipeline.types.ts';

const PRIMARY_ACCOUNT_FOLDER = path.join(homedir(), '.claude');
const CREDENTIALS_PATH = path.join(PRIMARY_ACCOUNT_FOLDER, '.credentials.json');

async function requestJson(request: HttpJsonRequest): Promise<HttpJsonResponse> {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  let json: unknown = null;
  try { json = await response.json(); } catch { json = null; }
  return { status: response.status, json };
}

function createRuntime(): PlanUsageDeps {
  return {
    readCredentialsFile: () => readClaudeCredentialsRaw(CREDENTIALS_PATH),
    httpJson: requestJson,
    now: () => new Date(),
    out: (line) => process.stdout.write(line),
    errOut: (line) => process.stderr.write(line),
    usageCacheFile: accountUsageCacheFile(PRIMARY_ACCOUNT_FOLDER),
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

  static forOtherAccountFolder(
    credentialsPath: string,
    httpJson: (request: HttpJsonRequest) => Promise<HttpJsonResponse> = requestJson,
  ): PlanUsagePlatformService {
    return new PlanUsagePlatformService({
      readCredentialsFile: () => readFile(credentialsPath, 'utf8'),
      httpJson,
      now: () => new Date(),
      out: (line) => process.stdout.write(line),
      errOut: (line) => process.stderr.write(line),
      usageCacheFile: accountUsageCacheFile(path.dirname(credentialsPath)),
    });
  }
}
