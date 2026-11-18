import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDeliveryListener, type DeliveryListener, type SubmitAttempt } from "../extensions/shared/agent-delivery-listener.ts";
import type { DeliveryHarness, DeliveryRequest } from "../extensions/shared/agent-delivery-contract.ts";

export const UNRECOGNIZED_COMPOSER_DETAIL =
  "Codex screen adapter v1 rejected visible-composer (active-composer-unrecognized): no attributable structural transition: no supported active bottom Codex composer was found";

export type StubRecipientState =
  | { readonly kind: "acknowledge" }
  | { readonly kind: "refuse"; readonly detail: string }
  | { readonly kind: "resident-draft"; readonly text: string }
  | { readonly kind: "turn-running" }
  | { readonly kind: "unreadable" };

export interface StubRecipientOptions {
  readonly pane: string;
  readonly harness?: DeliveryHarness;
  readonly commands?: boolean;
  readonly state?: StubRecipientState;
}

export interface StubRecipient {
  readonly socketPath: string;
  readonly requests: DeliveryRequest[];
  readonly submitted: DeliveryRequest[];
  readonly withdrawals: DeliveryRequest[];
  setState(state: StubRecipientState): void;
  stopListening(): Promise<void>;
  dispose(): Promise<void>;
}

function attemptFor(state: StubRecipientState): SubmitAttempt {
  if (state.kind === "acknowledge") return { status: "delivered", as: "turn" };
  if (state.kind === "refuse") return { status: "refused", detail: state.detail };
  if (state.kind === "resident-draft") return { status: "not-yet", reason: "draft" };
  if (state.kind === "turn-running") return { status: "not-yet", reason: "turn-running" };
  return { status: "not-yet", reason: "composer-unreadable" };
}

export async function createStubRecipient(options: StubRecipientOptions): Promise<StubRecipient> {
  const folder = await mkdtemp(path.join(tmpdir(), "stub-recipient-"));
  const socketPath = path.join(folder, "agent.sock");
  let state: StubRecipientState = options.state ?? { kind: "acknowledge" };
  const requests: DeliveryRequest[] = [];
  const submitted: DeliveryRequest[] = [];
  const withdrawals: DeliveryRequest[] = [];
  let listener: DeliveryListener | undefined = await startDeliveryListener({
    socketPath,
    pane: options.pane,
    harness: options.harness ?? "claude",
    commands: options.commands ?? false,
    tryDeliver: async (request, withdrawn) => {
      if (!requests.includes(request)) {
        requests.push(request);
        withdrawn.addEventListener("abort", () => {
          if (!submitted.includes(request)) withdrawals.push(request);
        }, { once: true });
      }
      const attempt = attemptFor(state);
      if (attempt.status === "delivered") submitted.push(request);
      return attempt;
    },
  });
  const stopListening = async () => {
    await listener?.close();
    listener = undefined;
  };
  return {
    socketPath,
    requests,
    submitted,
    withdrawals,
    setState(next) {
      state = next;
    },
    stopListening,
    async dispose() {
      await stopListening();
      await rm(folder, { recursive: true, force: true });
    },
  };
}
