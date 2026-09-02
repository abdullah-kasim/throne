// send-agent's innermost submit for omp is a handshake with the throne's omp
// extension, not keystrokes. Measured 2026-08-26 on a live session: the
// keystroke path wrote the payload into the composer and never submitted it,
// while `herdr agent prompt` typed into a resident draft and submitted the
// concatenation.
//
// The queue and the per-recipient lock are unchanged — only this innermost
// step differs — so these tests cover the handshake itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deliverToOmp,
  ompRequestPrefix,
} from "../src/herdr/omp-delivery-client.ts";

/** Every request is addressed to a pane; these tests use one unless the test
 *  is specifically about addressing. */
const PANE = "w2:p7JQ";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "omp-deliver-"));
}

/** Stands in for the extension: waits `afterMs` of virtual time, then acks. */
function extensionThatAcks(
  directory: string,
  status: string,
  detail?: string,
  paneId?: string,
): () => Promise<void> {
  return async () => {
    const entries = await readdir(directory);
    const request = entries.find((e) => e.startsWith("req-"));
    if (request === undefined) return;
    const { id, paneId: addressedPaneId } = JSON.parse(await readFile(join(directory, request), "utf8"));
    const body: Record<string, unknown> = { id, status, paneId: paneId ?? addressedPaneId };
    if (detail !== undefined) body.detail = detail;
    await writeFile(join(directory, `ack-${id}.json`), JSON.stringify(body));
  };
}

test("a delivered ack is a delivered verdict", async () => {
  const dir = await scratch();
  try {
    const ack = extensionThatAcks(dir, "delivered");
    const outcome = await deliverToOmp("hello", 5_000, PANE, {
      directory: dir,
      sleep: async () => {
        await ack();
      },
    });
    assert.deepEqual(outcome, { kind: "delivered" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delivered ack from another pane is refused", async () => {
  const dir = await scratch();
  try {
    const ack = extensionThatAcks(dir, "delivered", undefined, "wrong-pane");
    const outcome = await deliverToOmp("hello", 5_000, PANE, {
      directory: dir,
      sleep: async () => {
        await ack();
      },
    });
    assert.deepEqual(outcome, {
      kind: "refused",
      detail: 'omp extension acknowledgement identified pane "wrong-pane", not recipient pane "w2:p7JQ"',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the request carries the exact payload, written atomically", async () => {
  const dir = await scratch();
  try {
    let seen: string | undefined;
    await deliverToOmp("the whole payload, verbatim", 200, PANE, {
      directory: dir,
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      sleep: async () => {
        const entries = await readdir(dir);
        // No .partial file may ever be visible to the extension's poll.
        assert.equal(entries.some((e) => e.endsWith(".partial")), false);
        const request = entries.find((e) => e.startsWith("req-"));
        if (request) seen = await readFile(join(dir, request), "utf8");
      },
    });
    assert.match(seen ?? "", /the whole payload, verbatim/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refused ack reports the extension's own reason", async () => {
  const dir = await scratch();
  try {
    const ack = extensionThatAcks(dir, "refused", "sendUserMessage threw: boom");
    const outcome = await deliverToOmp("hello", 5_000, PANE, {
      directory: dir,
      sleep: async () => {
        await ack();
      },
    });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.detail, /sendUserMessage threw: boom/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("no ack inside the deadline is timed-out, and WITHDRAWS the request", async () => {
  // The withdrawal is the point. A request left behind could be picked up
  // after the caller was told not-sent, delivering a message it believes never
  // arrived — a duplicate is worse than a retry.
  const dir = await scratch();
  try {
    let clock = 0;
    const outcome = await deliverToOmp("hello", 1_000, PANE, {
      directory: dir,
      now: () => clock,
      sleep: async () => {
        clock += 400;
      },
    });
    assert.equal(outcome.kind, "timed-out");
    const left = await readdir(dir);
    assert.deepEqual(
      left.filter((e) => e.startsWith("req-")),
      [],
      "a timed-out request must not be left for a late pickup",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unparseable ack is refused, never read as delivered", async () => {
  const dir = await scratch();
  try {
    const outcome = await deliverToOmp("hello", 5_000, PANE, {
      directory: dir,
      sleep: async () => {
        const entries = await readdir(dir);
        const request = entries.find((e) => e.startsWith("req-"));
        if (request === undefined) return;
        const { id } = JSON.parse(await readFile(join(dir, request), "utf8"));
        await writeFile(join(dir, `ack-${id}.json`), "{ not json");
      },
    });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.detail, /unparseable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ack with an unknown status is refused rather than assumed good", async () => {
  const dir = await scratch();
  try {
    const ack = extensionThatAcks(dir, "something-new");
    const outcome = await deliverToOmp("hello", 5_000, PANE, {
      directory: dir,
      sleep: async () => {
        await ack();
      },
    });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.detail, /something-new/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ADDRESSING. The defect these cover, measured 2026-08-26: three live omp
// instances shared one delivery directory, the request carried no recipient,
// and each instance claimed any `req-*.json` it saw. Whichever instance had an
// empty composer won the message — so a brief for one Alpha was answered by
// another, and the throne still recorded "delivered".
// ---------------------------------------------------------------------------

/** The extension's claim rule, verbatim: filename prefix, then a body re-check.
 *  Kept in step with extensions/omp/throne-omp-delivery.ts. */
function extensionWouldClaim(paneId: string, entry: string, body: unknown): boolean {
  if (paneId.trim() === "") return false; // fail closed: no identity, no delivery
  const prefix = ompRequestPrefix(paneId);
  if (!entry.startsWith(prefix) || !entry.endsWith(".json")) return false;
  const addressed = (body as { paneId?: unknown })?.paneId;
  return typeof addressed !== "string" || addressed === paneId;
}

test("a request is claimed by its addressee and IGNORED by every other pane", async () => {
  const dir = await scratch();
  try {
    // Captured DURING the poll: a timed-out request is withdrawn, so reading
    // the directory afterwards would find nothing.
    let entry: string | undefined;
    let raw: string | undefined;
    await deliverToOmp("for the sqd alpha only", 200, "w2:p7JS", {
      directory: dir,
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      sleep: async () => {
        const found = (await readdir(dir)).filter((e) => e.startsWith("req-"));
        if (found[0] !== undefined) {
          entry = found[0];
          raw = await readFile(join(dir, found[0]), "utf8");
        }
      },
    });
    assert.ok(entry, "the request must exist to be claimed");
    const body = JSON.parse(raw ?? "{}");

    assert.equal(extensionWouldClaim("w2:p7JS", entry, body), true);
    // The two other live instances from the measured incident.
    assert.equal(extensionWouldClaim("w2:p7JQ", entry, body), false);
    assert.equal(extensionWouldClaim("w2:p7JT", entry, body), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an instance with no HERDR_PANE_ID delivers NOTHING rather than everything", async () => {
  const dir = await scratch();
  try {
    // Captured DURING the poll: a timed-out request is withdrawn, so reading
    // the directory afterwards would find nothing.
    let entry: string | undefined;
    let raw: string | undefined;
    await deliverToOmp("addressed elsewhere", 200, "w2:p7JS", {
      directory: dir,
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      sleep: async () => {
        const found = (await readdir(dir)).filter((e) => e.startsWith("req-"));
        if (found[0] !== undefined) {
          entry = found[0];
          raw = await readFile(join(dir, found[0]), "utf8");
        }
      },
    });
    assert.ok(entry, "the request must exist to be tested against");
    const body = JSON.parse(raw ?? "{}");
    // Falling back to "take everything" is the original defect, so an instance
    // that cannot identify itself must go silent instead.
    assert.equal(extensionWouldClaim("", entry, body), false);
    assert.equal(extensionWouldClaim("   ", entry, body), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sanitized-filename collision is still refused by the body re-check", async () => {
  // `w2:p7JQ` and `w2_p7JQ` sanitize to the same filename token, so the
  // filename alone would hand one pane the other's message.
  const dir = await scratch();
  try {
    // Captured DURING the poll: a timed-out request is withdrawn, so reading
    // the directory afterwards would find nothing.
    let entry: string | undefined;
    let raw: string | undefined;
    await deliverToOmp("for the colon pane", 200, "w2:p7JQ", {
      directory: dir,
      now: (() => {
        let t = 0;
        return () => (t += 100);
      })(),
      sleep: async () => {
        const found = (await readdir(dir)).filter((e) => e.startsWith("req-"));
        if (found[0] !== undefined) {
          entry = found[0];
          raw = await readFile(join(dir, found[0]), "utf8");
        }
      },
    });
    assert.ok(entry, "the request must exist to be tested against");
    const body = JSON.parse(raw ?? "{}");
    assert.equal(
      ompRequestPrefix("w2_p7JQ"),
      ompRequestPrefix("w2:p7JQ"),
      "this test is only meaningful while the two collide",
    );
    assert.equal(extensionWouldClaim("w2_p7JQ", entry, body), false);
    assert.equal(extensionWouldClaim("w2:p7JQ", entry, body), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unaddressed delivery is refused, never broadcast", async () => {
  const dir = await scratch();
  try {
    const outcome = await deliverToOmp("nobody in particular", 5_000, "", {
      directory: dir,
    });
    assert.equal(outcome.kind, "refused");
    assert.match(outcome.detail, /recipient pane id/);
    assert.deepEqual(
      (await readdir(dir)).filter((e) => e.startsWith("req-")),
      [],
      "a refused delivery must not leave a request for anyone to claim",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the extension's claim rule has not drifted from the mirror above", async () => {
  // `extensionWouldClaim` is a re-implementation: the extension is @ts-nocheck
  // JS loaded by omp's own runtime and cannot be imported here. A mirror that
  // silently drifts would prove nothing at all, so pin the three lines the
  // mirror copies. If this fails, the mirror is stale — fix the mirror, do not
  // delete the assertion.
  const source = await readFile(
    new URL("../extensions/omp/throne-omp-delivery.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /replace\(\/\[\^A-Za-z0-9_-\]\/g, "_"\)/,
    "sanitizePaneId must match src/herdr/omp-delivery-client.ts character for character",
  );
  assert.match(
    source,
    /`req-\$\{sanitizePaneId\(PANE_ID\)\}-`/,
    "the request prefix shape must match ompRequestPrefix",
  );
  assert.match(
    source,
    /PANE_ID === "" \? null/,
    "an instance with no pane id must fail closed",
  );
  assert.match(
    source,
    /entry\.startsWith\(REQUEST_PREFIX\)/,
    "claiming must be scoped by the addressed prefix",
  );
});
