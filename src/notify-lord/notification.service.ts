import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { NTFY_USER_CONFIG } from '../application-config.service.ts';
import {
  readAgentRole,
  IdentityLineReadStatus,
} from '../agentdata/identity-data.service.ts';
import { LedgerDataService } from '../agentdata/ledger-data.service.ts';
import { REAP_REASON, type ReapReason } from "../agent-timings/reap-reason.ts";
import {
  LIVE_QUEUE_ITEM_STATUSES,
  renderRegentQueueAsMarkdown,
} from "../regent-queue/regent-queue-render.ts";
import { openRegentQueueStore } from "../regent-queue/regent-queue.store.ts";
import {
  LIVE_ROLE_WORD_UNION,
  resolveCanonicalRoleWord,
} from "../shared-policy/role-word-union.ts";
import { FILE_BACKED_DELIVERY_THRESHOLD_BYTES } from "../send-agent/payload-transport.ts";

// The committed tree carries a deliberately inert loopback identity. The real
// server address and topic are host-local secrets (a private tailnet IP and an
// unguessable topic anyone could publish to), so they live in the gitignored
// `config.user.ts` `ntfy` section — see `agent_docs/ntfy-phone-notifications.md`.
// Precedence, highest first: `THRONE_NTFY_*` env var, `config.user.ts`, these.
const DEFAULT_SERVER_URL = "http://127.0.0.1:8410";
const DEFAULT_TOPIC = "throne-notifications";
const DEFAULT_TIMEOUT_MS = 5_000;
export const MAX_COMPLETION_MESSAGE_BYTES =
  FILE_BACKED_DELIVERY_THRESHOLD_BYTES - 1;
const COMPLETION_TRUNCATION_SUFFIX = "\nQueue: [truncated]";
const ledgerData = new LedgerDataService();

function envValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? fallback : normalized;
}

export interface NotifyConfig {
  serverUrl: string;
  topic: string;
  timeoutMs: number;
  notifyShadows: boolean;
}

/**
 * Notification configuration is captured once per process. Set
 * `THRONE_NOTIFY_SHADOWS=1` to opt into internal Shadow completion pushes;
 * completed Alphas remain the only default notification source.
 */
export const NOTIFY_CONFIG: Readonly<NotifyConfig> = Object.freeze({
  serverUrl: envValue(
    process.env.THRONE_NTFY_SERVER_URL,
    NTFY_USER_CONFIG.serverUrl ?? DEFAULT_SERVER_URL,
  ),
  topic: envValue(
    process.env.THRONE_NTFY_TOPIC,
    NTFY_USER_CONFIG.topic ?? DEFAULT_TOPIC,
  ),
  timeoutMs: DEFAULT_TIMEOUT_MS,
  notifyShadows: process.env.THRONE_NOTIFY_SHADOWS === "1",
});

export function shouldNotify(input: {
  reason: ReapReason;
  role: string;
  notifyShadows: boolean;
}): boolean {
  if (input.reason !== REAP_REASON.COMPLETED) return false;
  const role = input.role.trim().toLowerCase();
  return role === "alpha" || (input.notifyShadows && role === "shadow");
}

function headingFromMarkdown(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1].replace(/^\d+\s*[—:-]\s*/, "").trim();
    }
  }
  return undefined;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function boundCompletionMessage(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_COMPLETION_MESSAGE_BYTES) {
    return message;
  }
  const suffixBytes = Buffer.byteLength(COMPLETION_TRUNCATION_SUFFIX, "utf8");
  const firstLineEnd = message.indexOf("\n");
  const queueStart = message.indexOf("\n", firstLineEnd + 1);
  if (firstLineEnd === -1 || queueStart === -1) {
    return truncateUtf8(message, MAX_COMPLETION_MESSAGE_BYTES);
  }
  const prefix = message.slice(0, queueStart + 1);
  const availableBytes =
    MAX_COMPLETION_MESSAGE_BYTES -
    Buffer.byteLength(prefix, "utf8") -
    suffixBytes;
  if (availableBytes <= 0) {
    return truncateUtf8(message, MAX_COMPLETION_MESSAGE_BYTES);
  }
  return prefix + truncateUtf8(message.slice(queueStart + 1), availableBytes) + COMPLETION_TRUNCATION_SUFFIX;
}

async function readHeading(file: string): Promise<string | undefined> {
  try {
    return headingFromMarkdown(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export async function readAgentObjective(
  name: string,
  baseDir?: string,
): Promise<string | undefined> {
  const dir = baseDir === undefined ? ledgerData.agentDir(name) : path.join(baseDir, name);
  const explicitObjective = await readHeading(path.join(dir, "OBJECTIVE.md"));
  if (explicitObjective !== undefined) return explicitObjective;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const bundles = entries
    .filter((entry) => entry.isDirectory() && /^todo[-_]/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const bundle of bundles) {
    for (const overview of ["00_overview.md", "00-overview.md"]) {
      const objective = await readHeading(path.join(dir, bundle, overview));
      if (objective !== undefined) return objective;
    }
  }

  for (const fallback of ["ASSIGNMENT.md", "REPORT.md"]) {
    const objective = await readHeading(path.join(dir, fallback));
    if (objective !== undefined) return objective;
  }
  return undefined;
}

/**
 * Derive an Alpha campaign's objective code from its herdr name
 * (`alpha-<code>-…` → `<code>`, lowercased) so the completing campaign can
 * self-filter its own live-queue entry. Shadow and other non-canonical names
 * yield `undefined` — no filtering, since a Shadow completion push (the
 * `THRONE_NOTIFY_SHADOWS=1` debug path) reports on a campaign that really is
 * still in flight.
 */
export function objectiveCodeFromAlphaName(name: string): string | undefined {
  const resolved = resolveCanonicalRoleWord(name, LIVE_ROLE_WORD_UNION);
  if (resolved?.role !== "alpha") return undefined;
  return /^([a-z0-9]+)-/i.exec(resolved.rest)?.[1]?.toLowerCase();
}

/**
 * `queue` is the already-rendered live-items-only markdown from
 * `renderRegentQueueAsMarkdown`, or the literal `"unavailable"` when the
 * store could not be read.
 */
export function buildCompletionMessage(input: {
  name: string;
  objective?: string;
  queue: string | "unavailable";
}): string {
  const objective = input.objective?.trim();
  const lines = [`Campaign completed: ${input.name}`];
  if (objective !== undefined && objective !== "") {
    lines.push(`Objective: ${objective}`);
  }
  lines.push(
    input.queue === "unavailable" ? "Queue: unavailable" : input.queue.trimEnd(),
  );
  return boundCompletionMessage(lines.join("\n"));
}

export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface PostNtfyMessageOptions {
  title?: string;
  fetchImpl?: FetchLike;
}

export type NotificationTransport = (
  message: string,
  config: Pick<NotifyConfig, "serverUrl" | "topic" | "timeoutMs">,
  options: PostNtfyMessageOptions,
) => Promise<void>;

const COMPLETION_NOTIFICATION_TITLE = "Throne campaign completed";
const MAX_REJECTION_REASON_BYTES = 512;
const realFetch: FetchLike = (url, init) => fetch(url, init);

async function readRejectionReason(response: {
  text: () => Promise<string>;
}): Promise<string | undefined> {
  try {
    const body = await response.text();
    const normalized = body.replace(/\s+/g, " ").trim();
    if (normalized === "") return undefined;
    return truncateUtf8(normalized, MAX_REJECTION_REASON_BYTES);
  } catch {
    return undefined;
  }
}

export async function postNtfyMessage(
  message: string,
  config: Pick<
    NotifyConfig,
    "serverUrl" | "topic" | "timeoutMs"
  > = NOTIFY_CONFIG,
  options: PostNtfyMessageOptions = {},
): Promise<void> {
  const base = `${config.serverUrl.replace(/\/+$/, "")}/`;
  const url = new URL(encodeURIComponent(config.topic), base).toString();
  const response = await (options.fetchImpl ?? realFetch)(url, {
    method: "POST",
    body: message,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: options.title ?? COMPLETION_NOTIFICATION_TITLE,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    const reason = await readRejectionReason(response);
    const detail = reason === undefined ? "" : `: ${reason}`;
    throw new Error(`ntfy POST failed with HTTP ${response.status}${detail}`);
  }
}

export interface NotifyDeps {
  readAgentRole: typeof readAgentRole;
  readAgentObjective: (name: string) => Promise<string | undefined>;
  /**
   * The live-items-only queue view, rendered from the SQLite store —
   * `excludeObjectiveCode`, when given, drops the completing campaign's own
   * still-in-flight entry. Rejects when the store is unreadable.
   */
  renderQueue: (excludeObjectiveCode?: string) => Promise<string>;
  postMessage: (
    message: string,
    config: Pick<NotifyConfig, "serverUrl" | "topic" | "timeoutMs">,
  ) => Promise<void>;
}

const REAL_DEPS: NotifyDeps = {
  readAgentRole,
  readAgentObjective,
  renderQueue: async (excludeObjectiveCode) => {
    const store = openRegentQueueStore();
    try {
      return renderRegentQueueAsMarkdown(store.readAll(), {
        statuses: LIVE_QUEUE_ITEM_STATUSES,
        excludeObjectiveCode,
      });
    } finally {
      store.close();
    }
  },
  postMessage: postNtfyMessage,
};

export async function notifyAgentCompletion(
  name: string,
  reason: ReapReason,
  deps: NotifyDeps = REAL_DEPS,
  config: Readonly<NotifyConfig> = NOTIFY_CONFIG,
): Promise<boolean> {
  const roleRead = await deps.readAgentRole(name);
  // An unresolved role read must never silently suppress the completion
  // push -- the same "never suppress on a degraded read" precedent the
  // queue-read failure below already follows. A field-absent role (the file
  // read fine, no Role line) is the pre-existing, deliberately silencing
  // case: `shouldNotify` already treats an empty/unrecognized role as "don't
  // notify."
  if (roleRead.status !== IdentityLineReadStatus.ReadUnresolved) {
    const role =
      roleRead.status === IdentityLineReadStatus.Found ? roleRead.value : "";
    if (!shouldNotify({ reason, role, notifyShadows: config.notifyShadows })) {
      return false;
    }
  }

  const objective = await deps.readAgentObjective(name);
  let queue: string | "unavailable";
  try {
    queue = await deps.renderQueue(objectiveCodeFromAlphaName(name));
  } catch {
    // A queue-read failure must never suppress the completion push itself —
    // the campaign-completed part always sends, with the queue section
    // degraded instead of missing.
    queue = "unavailable";
  }
  await deps.postMessage(
    buildCompletionMessage({ name, objective, queue }),
    config,
  );
  return true;
}

export class NotificationService {
  private readonly transport: NotificationTransport;
  private readonly config: Readonly<NotifyConfig>;

  constructor(
    transport: NotificationTransport = postNtfyMessage,
    config: Readonly<NotifyConfig> = NOTIFY_CONFIG,
  ) {
    this.transport = transport;
    this.config = config;
  }

  send(message: string, options: PostNtfyMessageOptions = {}): Promise<void> {
    return this.transport(message, this.config, options);
  }
}
