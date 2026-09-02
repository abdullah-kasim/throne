import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { RUNTIME_THRONE_ROOT } from '../shared-policy/runtime-throne-root.ts';
import { consumePayload, REAL_PAYLOAD_CONSUMPTION_DEPS } from '../read-payload/payload-consumption.ts';
export const FILE_BACKED_PAYLOAD_DIR = join(homedir(), '.throne', 'payloads');
export const FILE_BACKED_DELIVERY_THRESHOLD_BYTES = 4096;
export const FILE_BACKED_PAYLOAD_DIR_MODE = 0o700;
export const FILE_BACKED_PAYLOAD_FILE_MODE = 0o600;
export const FILE_BACKED_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
export interface StagedPayload { path: string; byteLength: number; sha256: string }
export interface FileBackedDeliveryDeps { mkdir: typeof mkdir; writeFile: typeof writeFile; chmod: typeof chmod; readdir: typeof readdir; stat: typeof stat; rm: typeof rm; open: typeof open; now: () => number }
export const REAL_FILE_BACKED_DELIVERY_DEPS: FileBackedDeliveryDeps = { mkdir, writeFile, chmod, readdir, stat, rm, open, now: () => Date.now() };
export class PayloadWriteError extends Error { readonly name = 'PayloadWriteError'; readonly path: string; readonly cause: unknown; constructor(path: string, cause: unknown) { super(`failed to stage file-backed payload at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); this.path = path; this.cause = cause; } }
export function requiresFileBackedDelivery(prompt: string): boolean { return Buffer.byteLength(prompt, 'utf8') >= FILE_BACKED_DELIVERY_THRESHOLD_BYTES; }
export function payloadFileName(recipient: string, now: number, entropy: string): string { return `${recipient.replace(/[^A-Za-z0-9._-]/gu, '_')}-${now.toString(36)}-${entropy}.payload.txt`; }
export type PayloadReapReporter = (message: string) => void;
export interface PayloadStageMaintenanceDeps { startReaper: (deps: FileBackedDeliveryDeps, report: PayloadReapReporter) => void; report: PayloadReapReporter }
function missing(error: unknown): boolean { return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'; }
function text(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export interface ReapOutcome { reaped: string[]; retained: string[] }
export async function reapStalePayloads(deps: FileBackedDeliveryDeps = REAL_FILE_BACKED_DELIVERY_DEPS): Promise<ReapOutcome> { const outcome: ReapOutcome = { reaped: [], retained: [] }; let entries: string[]; try { entries = await deps.readdir(FILE_BACKED_PAYLOAD_DIR); } catch (error) { if (missing(error)) return outcome; throw error; } for (const entry of entries) { if (!entry.endsWith('.payload.txt')) continue; const path = join(FILE_BACKED_PAYLOAD_DIR, entry); try { if (deps.now() - (await deps.stat(path)).mtimeMs >= FILE_BACKED_PAYLOAD_TTL_MS) { await deps.rm(path, { force: true }); outcome.reaped.push(path); } else outcome.retained.push(path); } catch (error) { if (!missing(error)) throw error; } } return outcome; }
export function formatPayloadReapFailure(trigger: 'before-staging' | 'startup', error: unknown): string { return `file-backed payload reaper (${trigger}) FAILED (${text(error)}); continuing without blocking the calling path\n`; }
export function formatPayloadReapSummary(trigger: 'before-staging' | 'startup', outcome: ReapOutcome): string { return `file-backed payload reaper (${trigger}) — reaped ${outcome.reaped.length}, retained ${outcome.retained.length}\n`; }
export function startOpportunisticPayloadReap(deps: FileBackedDeliveryDeps, report: PayloadReapReporter): void { void reapStalePayloads(deps).then((outcome) => { if (outcome.reaped.length) report(formatPayloadReapSummary('before-staging', outcome)); }, (error) => { try { report(formatPayloadReapFailure('before-staging', error)); } catch {} }); }
export async function stagePayload(recipient: string, body: string, deps: FileBackedDeliveryDeps = REAL_FILE_BACKED_DELIVERY_DEPS, maintenance: PayloadStageMaintenanceDeps = { startReaper: startOpportunisticPayloadReap, report: (message) => process.stderr.write(message) }): Promise<StagedPayload> { try { maintenance.startReaper(deps, maintenance.report); } catch (error) { try { maintenance.report(formatPayloadReapFailure('before-staging', error)); } catch {} } const now = deps.now(); const entropy = createHash('sha256').update(`${process.pid}:${now}:${recipient}:${body.length}`).digest('hex').slice(0, 12); const path = join(FILE_BACKED_PAYLOAD_DIR, payloadFileName(recipient, now, entropy)); try { await deps.mkdir(FILE_BACKED_PAYLOAD_DIR, { recursive: true, mode: FILE_BACKED_PAYLOAD_DIR_MODE }); await deps.chmod(FILE_BACKED_PAYLOAD_DIR, FILE_BACKED_PAYLOAD_DIR_MODE); await deps.writeFile(path, body, { encoding: 'utf8', mode: FILE_BACKED_PAYLOAD_FILE_MODE, flag: 'wx' }); await deps.chmod(path, FILE_BACKED_PAYLOAD_FILE_MODE); } catch (error) { throw new PayloadWriteError(path, error); } return { path, byteLength: Buffer.byteLength(body, 'utf8'), sha256: createHash('sha256').update(body, 'utf8').digest('hex') }; }
export function buildPointerMessage(staged: StagedPayload): string { return `Large message — read then delete: ${JSON.stringify(resolve(RUNTIME_THRONE_ROOT, 'bin/throne-cli'))} read-payload ${JSON.stringify(staged.path)}`; }
export function pointerMessageFitsDirectPath(pointer: string): boolean { return Buffer.byteLength(pointer, 'utf8') < FILE_BACKED_DELIVERY_THRESHOLD_BYTES; }
