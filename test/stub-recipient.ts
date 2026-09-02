import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const UNRECOGNIZED_COMPOSER_DETAIL =
  "Codex screen adapter v1 rejected visible-composer (active-composer-unrecognized): no attributable structural transition: no supported active bottom Codex composer was found";

export type StubRecipientState =
  | { readonly kind: "acknowledge" }
  | { readonly kind: "refuse"; readonly detail: string }
  | { readonly kind: "resident-draft"; readonly text: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "never-answer" };

export type StubPaneProjection =
  | { readonly status: "ready"; readonly composer: "empty" }
  | { readonly status: "in-flight"; readonly composer: "draft"; readonly text: string }
  | { readonly status: "not-sent"; readonly composer: "unrecognized"; readonly detail: string }
  | { readonly status: "in-flight"; readonly composer: "unreadable" }
  | { readonly status: "in-flight"; readonly composer: "empty" };

interface PendingRequest {
  readonly id: string;
  readonly text: string;
  readonly path: string;
  readonly bytes: string;
}

export interface StubRecipient {
  readonly directory: string;
  setState(state: StubRecipientState): void;
  paneProjection(): StubPaneProjection;
  receivedRequestBytes(): readonly string[];
  deliveryCount(): number;
  processPendingDelivery(): Promise<void>;
  dispose(): Promise<void>;
}

function canDeliverPendingRequest(state: StubRecipientState): boolean {
  return state.kind === "acknowledge" || state.kind === "refuse";
}

function parsePendingRequest(filePath: string, bytes: string): PendingRequest {
  const parsed = JSON.parse(bytes) as { id?: unknown; text?: unknown; paneId?: unknown };
  if (typeof parsed.id !== "string" || typeof parsed.text !== "string" || typeof parsed.paneId !== "string") {
    throw new Error(`stub recipient rejected malformed request at ${filePath}`);
  }
  return { id: parsed.id, text: parsed.text, path: filePath, bytes };
}

async function writeAcknowledgement(
  directory: string,
  request: PendingRequest,
  state: Extract<StubRecipientState, { kind: "acknowledge" | "refuse" }>,
): Promise<void> {
  const ack = state.kind === "acknowledge"
    ? { id: request.id, status: "delivered", paneId: JSON.parse(request.bytes).paneId }
    : { id: request.id, status: "refused", detail: state.detail, paneId: JSON.parse(request.bytes).paneId };
  await writeFile(path.join(directory, `ack-${request.id}.json`), JSON.stringify(ack), "utf8");
}

export async function createStubRecipient(
  initialState: StubRecipientState = { kind: "acknowledge" },
): Promise<StubRecipient> {
  const directory = await mkdtemp(path.join(tmpdir(), "throne-stub-recipient-"));
  let state = initialState;
  let deliveries = 0;
  const received: string[] = [];
  const receivedIds = new Set<string>();
  const processed = new Set<string>();

  const findPendingRequest = async (): Promise<PendingRequest | undefined> => {
    const fileName = (await readdir(directory)).find(
      (entry) => entry.startsWith("req-") && entry.endsWith(".json"),
    );
    if (fileName === undefined) return undefined;
    const filePath = path.join(directory, fileName);
    return parsePendingRequest(filePath, await readFile(filePath, "utf8"));
  };

  return {
    directory,
    setState(nextState) {
      state = nextState;
    },
    paneProjection() {
      if (state.kind === "resident-draft") {
        return { status: "in-flight", composer: "draft", text: state.text };
      }
      if (state.kind === "refuse") {
        return { status: "not-sent", composer: "unrecognized", detail: state.detail };
      }
      if (state.kind === "unreadable") {
        return { status: "in-flight", composer: "unreadable" };
      }
      return { status: "in-flight", composer: "empty" };
    },
    receivedRequestBytes() {
      return received;
    },
    deliveryCount() {
      return deliveries;
    },
    async processPendingDelivery() {
      const request = await findPendingRequest();
      if (request === undefined) return;
      if (!receivedIds.has(request.id)) {
        receivedIds.add(request.id);
        received.push(request.bytes);
      }
      if (!canDeliverPendingRequest(state)) return;
      if (!processed.has(request.id)) {
        processed.add(request.id);
        if (state.kind === "acknowledge") deliveries += 1;
      }
      await writeAcknowledgement(directory, request, state);
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
