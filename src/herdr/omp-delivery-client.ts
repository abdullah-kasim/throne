import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * The throne half of omp delivery. Writes a request the throne's omp
 * extension picks up, then waits for that extension's ack.
 *
 * WHY NOT KEYSTROKES. omp panes are `screen_detection_skipped`, so the
 * composer observation behind "never overwrite a resident draft" has nothing
 * to read, and the Claude-branch submit contract does not apply. Measured on
 * 2026-08-26: the keystroke path wrote the payload and never submitted it,
 * while `herdr agent prompt` typed into a resident draft and submitted the
 * concatenation — "test" plus an incoming message became the single turn
 * "testreply ONLY with the word banana".
 *
 * The extension reads the ACTUAL composer buffer and enqueues a real user
 * turn, so the draft protection is exact rather than inferred, and the
 * "delivered" verdict means sendUserMessage returned rather than that a write
 * was attempted.
 *
 * THE DRAFT WAIT LIVES ON THE EXTENSION SIDE. It holds the request while a
 * draft is resident, and holds it equally while the composer is unreadable.
 * This side only bounds how long it is willing to wait, exactly as every
 * other harness bounds its own composer wait.
 */
export const OMP_DELIVERY_DIR_ENV = "THRONE_OMP_DELIVERY_DIR";
export const OMP_DELIVERY_POLL_MS = 250;

/**
 * The environment variable herdr sets in every pane it owns, and therefore the
 * only thing an omp instance knows about WHICH agent it is. The extension reads
 * it to decide which requests are addressed to it.
 */
export const HERDR_PANE_ID_ENV = "HERDR_PANE_ID";

/**
 * REQUESTS ARE ADDRESSED, NOT BROADCAST.
 *
 * Measured 2026-08-26 with three live omp instances (panes w2:p7JQ, w2:p7JS,
 * w2:p7JT): every instance polled one shared directory and claimed ANY
 * `req-*.json` it found, because the request carried only `{id, text}` and no
 * recipient at all. Delivery was therefore a race — the first instance with an
 * empty composer won, whoever the message was for — and `message-status` still
 * reported "delivered", because from the throne's side an ack had come back.
 * A message to one Alpha could be answered by a different Alpha entirely.
 *
 * The recipient's pane id is now part of the FILENAME as well as the body. The
 * filename is what lets an instance skip other agents' requests without
 * reading, parsing, or unlinking them; the body is the belt to that
 * suspenders, since two distinct pane ids could in principle sanitize to the
 * same token.
 */
export function ompRequestPrefix(paneId: string): string {
  return `req-${sanitizePaneId(paneId)}-`;
}

/** Pane ids look like `w2:p7JQ`; `:` is legal on Linux but not worth carrying
 *  through a filename. Collisions are possible in principle, which is exactly
 *  why the pane id is re-checked inside the request body. */
export function sanitizePaneId(paneId: string): string {
  return paneId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function ompDeliveryDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const configured = environment[OMP_DELIVERY_DIR_ENV]?.trim();
  return configured && configured !== ""
    ? path.resolve(configured)
    : path.join(home, ".throne", "data", ".runtime", "omp-delivery");
}

export type OmpDeliveryOutcome =
  | { readonly kind: "delivered" }
  /** The extension answered, and the answer was no. */
  | { readonly kind: "refused"; readonly detail: string }
  /**
   * No ack inside the deadline. The request is withdrawn before reporting, so
   * a late pickup cannot deliver a message the caller was already told was
   * not sent — a duplicate is worse than a retry.
   */
  | { readonly kind: "timed-out"; readonly waitedMs: number };

export interface OmpDeliveryDeps {
  readonly directory?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function deliverToOmp(
  text: string,
  timeoutMs: number,
  /**
   * The RECIPIENT's herdr pane id. Required, and deliberately positional
   * rather than an optional dep: an omitted recipient is what the broadcast
   * defect was, so it must not be possible to call this and get "whoever
   * answers first".
   */
  recipientPaneId: string,
  deps: OmpDeliveryDeps = {},
): Promise<OmpDeliveryOutcome> {
  if (recipientPaneId.trim() === "") {
    return {
      kind: "refused",
      detail: "omp delivery requires a recipient pane id; refusing to broadcast",
    };
  }
  const directory = deps.directory ?? ompDeliveryDirectory();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? wait;
  const pollMs = deps.pollMs ?? OMP_DELIVERY_POLL_MS;

  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  const requestPath = path.join(
    directory,
    `${ompRequestPrefix(recipientPaneId)}${id}.json`,
  );
  const ackPath = path.join(directory, `ack-${id}.json`);

  // Write-then-rename: the extension polls this directory, and must never
  // parse a half-written request.
  const staging = `${requestPath}.partial`;
  await writeFile(
    staging,
    `${JSON.stringify({ id, text, paneId: recipientPaneId })}\n`,
    "utf8",
  );
  await rename(staging, requestPath);

  const started = now();
  const deadline = started + timeoutMs;
  for (;;) {
    let body: string | undefined;
    try {
      body = await readFile(ackPath, "utf8");
    } catch {
      body = undefined;
    }
    if (body !== undefined) {
      await rm(ackPath, { force: true });
      let ack: { status?: string; detail?: string; paneId?: string };
      try {
        ack = JSON.parse(body);
      } catch {
        return { kind: "refused", detail: "unparseable ack from the omp extension" };
      }
      if (ack.paneId !== recipientPaneId) {
        return {
          kind: "refused",
          detail: `omp extension acknowledgement identified pane "${String(ack.paneId)}", not recipient pane "${recipientPaneId}"`,
        };
      }
      if (ack.status === "delivered") return { kind: "delivered" };
      return {
        kind: "refused",
        detail: ack.detail ?? `omp extension answered "${String(ack.status)}"`,
      };
    }
    if (now() >= deadline) {
      // Withdraw first, THEN report. The other order races: the extension
      // could pick the request up between the report and the removal, and the
      // caller would have been told not-sent about a message that arrived.
      await rm(requestPath, { force: true });
      await rm(ackPath, { force: true });
      return { kind: "timed-out", waitedMs: now() - started };
    }
    await sleep(pollMs);
  }
}
