// `codex-usage-remaining`: read the authoritative Codex (ChatGPT) plan-usage
// numbers from the same authenticated endpoint the `codex` CLI itself uses,
// and report how much plan headroom remains per cap window — a short human
// summary by default, or a machine-consumable object under `--json`.
//
// This command NEVER writes `~/.codex/auth.json`: an expired access token is
// reported as an honest failure instructing the user to run `codex` to refresh,
// rather than refreshed in memory. OpenAI's refresh tokens may rotate
// single-use, and this tool never writes the rotated token back to
// `~/.codex/auth.json` — an in-memory refresh here could strand the on-disk
// `refresh_token` and break the user's `codex` login.
//
// The one filesystem-WRITE seam is the shared usage cache (the injected
// `cacheIo`; real impl persists a per-harness last-good file at
// `~/.throne/usage-cache/codex.json`). On a transient endpoint error the
// last-good numbers are returned marked `stale` instead of failing. The
// credentials file above is still never written.
//
// Every failure mode — missing/unreadable/malformed credentials, a non-chatgpt
// auth mode, an expired token, a failed usage fetch, or a response that does
// not match the usage schema — exits non-zero with a clear cause (a stderr
// line in human mode, an `{"source":"error",...}` object in `--json` mode).
// It never prints a fabricated percentage.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type {
  HttpJsonRequest,
  HttpJsonResponse,
} from '../plan-usage-remaining/pipeline.types.ts';
import type { UsageWindow } from '../plan-usage-remaining/telemetry.types.ts';
import {
  cachedUsage,
  realUsageCacheIo,
  USAGE_CACHE_TTL_MS,
  type UsageCacheIo,
} from '../plan-usage-remaining/telemetry-core/cache.ts';
import {
  buildUsageLogRows,
  realAppendUsageLog,
  readUsageLogRaw,
  parseUsageLog,
  getBoundedForecastSamples,
  type UsageLogRow,
} from '../plan-usage-remaining/telemetry-core/log.ts';
import { HARNESS_NAMES } from '../harness-routing/harness.ts';
import { forecastUsageAtReset } from '../plan-usage-remaining/telemetry-core/forecast.ts';

const JSON_FLAG = '--json';
const AUTH_PATH = path.join(homedir(), '.codex', 'auth.json');
const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
// A bare/default User-Agent gets a Cloudflare 403 HTML page — both headers
// below are load-bearing, not cosmetic.
const USER_AGENT = 'codex_cli_rs/0.144.3';
const ORIGINATOR = 'codex_cli_rs';

// Skew so a token expiring mid-request still fails before the network call
// rather than during it.
const EXP_SKEW_MS = 60_000;

/** Injectable seam — defaults to real IO; tests supply fixtures. There is no
 * `~/.codex` write member on purpose: this tool never writes credentials. A
 * `cacheIo` (present on `REAL_DEPS`, omitted by the live-path tests) opts a
 * fetch into the shared last-good cache; without it the reader is live-only. */
export interface Deps {
  readAuthFile: () => Promise<string>;
  httpJson: (req: HttpJsonRequest) => Promise<HttpJsonResponse>;
  now: () => Date;
  out: (line: string) => void;
  errOut: (line: string) => void;
  cacheIo?: UsageCacheIo;
  // Optional like cacheIo: present on REAL_DEPS, omitted by the live-path tests.
  // Absent -> no logging; the fixture tests inject a capturing appender.
  appendUsageLog?: (rows: UsageLogRow[]) => Promise<void>;
  readUsageLog?: () => Promise<string>;
}
async function realHttpJson(req: HttpJsonRequest): Promise<HttpJsonResponse> {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const REAL_DEPS: Deps = {
  readAuthFile: () => readFile(AUTH_PATH, 'utf8'),
  httpJson: realHttpJson,
  now: () => new Date(),
  out: (line) => {
    process.stdout.write(line);
  },
  errOut: (line) => {
    process.stderr.write(line);
  },
  cacheIo: realUsageCacheIo(HARNESS_NAMES.CODEX),
  appendUsageLog: realAppendUsageLog(),
  readUsageLog: readUsageLogRaw,
};

export const REAL_CODEX_USAGE_DEPS: Deps = REAL_DEPS;

interface CodexTokens {
  accessToken: string;
  accountId: string;
}

/** The exact object `run(['--json'])` prints. */
export interface CodexUsagePayload {
  source: 'api' | 'error';
  harness: typeof HARNESS_NAMES.CODEX;
  as_of: string;
  windows?: UsageWindow[];
  error?: string;
  stale?: boolean; // true when served from cache after a live-fetch error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function snippetFrom(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

async function readCodexAuthFile(deps: Deps): Promise<string> {
  try {
    return await deps.readAuthFile();
  } catch (err) {
    throw new Error(`could not read Codex credentials (${errText(err)})`);
  }
}

function parseAuthFile(raw: string): CodexTokens {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Codex credentials file is not valid JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('Codex credentials file is not a JSON object');
  }
  if (parsed.auth_mode !== 'chatgpt') {
    throw new Error(
      `Codex credentials use auth_mode "${String(parsed.auth_mode)}", not "chatgpt" (API-key mode has no plan-usage endpoint)`,
    );
  }
  const tokens = parsed.tokens;
  if (!isRecord(tokens)) {
    throw new Error('Codex credentials file has no tokens object');
  }
  const { access_token: accessToken, account_id: accountId } = tokens;
  if (typeof accessToken !== 'string' || typeof accountId !== 'string') {
    throw new Error('Codex credentials are missing access_token/account_id');
  }
  return { accessToken, accountId };
}

/** Base64url-decode a JWT's payload segment (index 1 of 3) — no signature
 * verification, this only reads the claimed `exp`. */
function decodeJwtExpSeconds(jwt: string): number | undefined {
  const segments = jwt.split('.');
  if (segments.length < 2) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return isRecord(payload) && typeof payload.exp === 'number' ? payload.exp : undefined;
  } catch {
    return undefined;
  }
}

// If the token cannot be decoded or carries no numeric `exp`, proceed anyway —
// the server is the authority and a bad token surfaces as an HTTP error.
function assertNotExpired(accessToken: string, deps: Deps): void {
  const exp = decodeJwtExpSeconds(accessToken);
  if (exp === undefined) return;
  const expiresAtMs = exp * 1000;
  if (expiresAtMs <= deps.now().getTime() + EXP_SKEW_MS) {
    throw new Error(
      `Codex access token expired at ${new Date(expiresAtMs).toISOString()}; run \`codex\` to refresh your login`,
    );
  }
}

async function fetchUsage(
  tokens: CodexTokens,
  deps: Deps,
): Promise<Record<string, unknown>> {
  const res = await deps.httpJson({
    method: 'GET',
    url: USAGE_ENDPOINT,
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'chatgpt-account-id': tokens.accountId,
      'User-Agent': USER_AGENT,
      originator: ORIGINATOR,
    },
  });
  if (res.status !== 200) {
    throw new Error(`Codex usage request failed (HTTP ${res.status}): ${snippetFrom(res.json)}`);
  }
  if (!isRecord(res.json)) {
    throw new Error('Codex usage response was not a JSON object');
  }
  return res.json;
}

function capWindowLabel(limitWindowSeconds: number): string {
  if (limitWindowSeconds === 604800 || limitWindowSeconds === 2592000) return 'weekly';
  if (limitWindowSeconds === 18000) return '5h';
  return `${Math.round(limitWindowSeconds / 3600)}h`;
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : undefined;
}

// `used_percent` is ALREADY 0–100 and `reset_at` is epoch SECONDS (the inverse
// of the Claude sibling, whose `resets_at` is already ISO) — neither is
// rescaled here beyond the documented reset_at→ISO conversion. A window with
// no finite `used_percent` or `limit_window_seconds` is skipped, never
// zero-filled. The codex response carries no severity field, so `severity` is
// never set on the returned window.
function mapWindow(value: unknown, scopeModel?: string): UsageWindow | null {
  if (value === null || value === undefined || !isRecord(value)) return null;
  const usedPercent = value.used_percent;
  const limitWindowSeconds = value.limit_window_seconds;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return null;
  if (typeof limitWindowSeconds !== 'number' || !Number.isFinite(limitWindowSeconds)) return null;

  const label = capWindowLabel(limitWindowSeconds);
  const window: UsageWindow = {
    cap_window: scopeModel !== undefined ? `${label}:${scopeModel}` : label,
    used_pct: usedPercent,
    remaining_pct: 100 - usedPercent,
  };
  const resetTime = isoFromEpochSeconds(value.reset_at);
  if (resetTime !== undefined) window.reset_time = resetTime;
  if (scopeModel !== undefined) window.scope_model = scopeModel;
  return window;
}

function mapRateLimitWindows(rateLimit: Record<string, unknown>): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const primary = mapWindow(rateLimit.primary_window);
  if (primary) windows.push(primary);
  const secondary = mapWindow(rateLimit.secondary_window);
  if (secondary) windows.push(secondary);
  return windows;
}

function mapAdditionalRateLimits(value: unknown): UsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: UsageWindow[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const limitName = raw.limit_name;
    if (typeof limitName !== 'string') continue;
    const rateLimit = raw.rate_limit;
    if (!isRecord(rateLimit)) continue;
    const primary = mapWindow(rateLimit.primary_window, limitName);
    if (primary) windows.push(primary);
    const secondary = mapWindow(rateLimit.secondary_window, limitName);
    if (secondary) windows.push(secondary);
  }
  return windows;
}

function mapWindows(usage: Record<string, unknown>): UsageWindow[] {
  if (!isRecord(usage.rate_limit)) {
    throw new Error('Codex usage response was missing rate_limit');
  }
  return [
    ...mapRateLimitWindows(usage.rate_limit),
    ...mapAdditionalRateLimits(usage.additional_rate_limits),
  ];
}

function formatWindowLine(window: UsageWindow): string {
  const current = `${window.cap_window}: ${window.remaining_pct}% remaining (resets ${window.reset_time ?? 'unknown'})`;
  if (window.projected_remaining_pct === undefined) return current;
  const projection = window.projected_remaining_pct === null
    ? 'projection unavailable'
    : `projected ${window.projected_remaining_pct.toFixed(1)}% remaining at reset`;
  return `${current}; ${projection}`;
}

async function computeUsagePayload(deps: Deps): Promise<CodexUsagePayload> {
  const asOf = deps.now().toISOString();
  try {
    const tokens = parseAuthFile(await readCodexAuthFile(deps));
    assertNotExpired(tokens.accessToken, deps);
    const usage = await fetchUsage(tokens, deps);
    const windows = mapWindows(usage);
    return {
      source: 'api',
      harness: HARNESS_NAMES.CODEX,
      as_of: asOf,
      windows,
    };
  } catch (err) {
    return {
      source: 'error',
      harness: HARNESS_NAMES.CODEX,
      as_of: asOf,
      error: errText(err),
    };
  }
}

/** Route a fetch through the shared last-good cache when a `cacheIo` is present
 * (the real CLI and in-process callers); without one, fetch live exactly as
 * before — the seam that keeps the live-path tests byte-behavior-identical.
 * This is the SINGLE append firing point: every fetch (CLI `run` and the
 * in-process `getUsagePayload`) records exactly one reading-set here, so a call
 * logs once regardless of --json vs human and no caller double-logs. */
async function addHistoricalForecasts(payload: CodexUsagePayload, deps: Deps): Promise<void> {
  if (payload.source !== 'api' || payload.windows === undefined || deps.readUsageLog === undefined) return;
  const now = deps.now();
  const rows = parseUsageLog(await deps.readUsageLog());
  for (const window of payload.windows) {
    const samples = getBoundedForecastSamples(rows, payload.harness, window.cap_window, now);
    samples.push({
      recorded_at: payload.as_of,
      remaining_pct: window.remaining_pct,
      reset_time: window.reset_time ?? null,
    });
    window.projected_remaining_pct = forecastUsageAtReset({
      now: now.toISOString(),
      reset_time: window.reset_time ?? '',
      samples,
    }).projected_remaining_pct;
  }
}

async function fetchMaybeCached(deps: Deps): Promise<CodexUsagePayload> {
  const payload = deps.cacheIo
    ? await cachedUsage(() => computeUsagePayload(deps), deps.cacheIo, USAGE_CACHE_TTL_MS)
    : await computeUsagePayload(deps);
  await addHistoricalForecasts(payload, deps);
  await appendReadingLog(payload, deps);
  return payload;
}

// Best-effort append: record the observation now (deps.now(), not the payload's
// possibly-cached as_of) for correct trend semantics. An error or windowless
// payload logs nothing, and a log-write rejection never changes the fetch outcome.
async function appendReadingLog(payload: CodexUsagePayload, deps: Deps): Promise<void> {
  if (!deps.appendUsageLog) return;
  const rows = buildUsageLogRows(payload, deps.now().toISOString());
  if (rows.length === 0) return;
  try {
    await deps.appendUsageLog(rows);
  } catch {
    // Swallowed on purpose — usage logging must never fail a good read.
  }
}

/** In-process reuse seam — throttle/routing callers import this. */
export async function getUsagePayload(deps: Deps = REAL_DEPS): Promise<CodexUsagePayload> {
  return fetchMaybeCached(deps);
}

/** Environment-capability probe: does this run have usable, unexpired
 * chatgpt credentials to reach the real Codex usage API? Reuses the exact
 * read/parse/expiry checks `computeUsagePayload` runs, so a caller deciding
 * whether to expect a live `source: 'api'` result can never drift from the
 * runtime's own definition of "usable" (e.g. a hermetic test environment
 * with no `~/.codex/auth.json`, such as the suite container's scratch
 * `HOME`, correctly reports unusable rather than attempting a network call). */
export async function hasUsableCodexCredentials(deps: Deps = REAL_DEPS): Promise<boolean> {
  try {
    const tokens = parseAuthFile(await readCodexAuthFile(deps));
    assertNotExpired(tokens.accessToken, deps);
    return true;
  } catch {
    return false;
  }
}

export async function run(args: string[], deps: Deps = REAL_DEPS): Promise<number> {
  const jsonMode = args.includes(JSON_FLAG);
  const payload = await fetchMaybeCached(deps);
  if (jsonMode) {
    deps.out(`${JSON.stringify(payload)}\n`);
  } else if (payload.source === 'api') {
    for (const window of payload.windows ?? []) {
      deps.out(`${formatWindowLine(window)}\n`);
    }
    if (payload.stale) {
      deps.out(`(stale — last good ${payload.as_of})\n`);
    }
  } else {
    deps.errOut(`codex-usage-remaining: ${payload.error}\n`);
  }
  return payload.source === 'api' ? 0 : 1;
}
