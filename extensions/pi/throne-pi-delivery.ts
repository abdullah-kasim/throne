import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messageText } from "./throne-pi-state.ts";

type DeliveredAs = "turn" | "followUp";
type Waiter = { text: string; as: DeliveredAs; seen: () => void };

const CONTEXT_EVENTS = ["session_start", "session_switch", "agent_start", "turn_start", "turn_end", "message_start"];

function sharedModule(name: string): string {
  const extensionFile = realpathSync(fileURLToPath(import.meta.url));
  return path.join(path.dirname(path.dirname(extensionFile)), "shared", name);
}

function log(pi: any, line: string): void {
  try {
    pi.logger?.debug?.(`throne-pi-delivery: ${line}`);
  } catch {}
}

export default async function throneDeliveryExtension(pi: any) {
  const contract = await import(sharedModule("agent-delivery-contract.ts"));
  const { callbackTargetFrom, startDeliveryListener } = await import(sharedModule("agent-delivery-listener.ts"));
  const socketPath = (process.env[contract.DELIVERY_SOCKET_ENV] ?? "").trim();
  const pane = (process.env.HERDR_PANE_ID ?? "").trim();
  if (socketPath === "" || pane === "") {
    log(pi, `${contract.DELIVERY_SOCKET_ENV} or HERDR_PANE_ID is unset, so this pane delivers nothing; relaunch it through throne`);
    return undefined;
  }

  let context: any = null;
  const waiters = new Set<Waiter>();
  const settle = (matches: (waiter: Waiter) => boolean) => {
    for (const waiter of waiters) {
      if (!matches(waiter)) continue;
      waiters.delete(waiter);
      waiter.seen();
    }
  };
  for (const event of CONTEXT_EVENTS) {
    pi.on(event, (_event: unknown, eventContext: any) => {
      if (eventContext?.ui) context = eventContext;
    });
  }
  pi.on("message_start", (event: any) => {
    if (event?.message?.role !== "user") return;
    const text = messageText(event.message.content);
    settle((waiter) => waiter.text === text);
  });
  pi.on("turn_start", () => settle((waiter) => waiter.as === "turn"));

  const readDraft = (): string | null => {
    try {
      const value = context?.ui?.getEditorText?.call(context.ui);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  const restoreDraft = (draft: string): boolean => {
    try {
      const setEditorText = context?.ui?.setEditorText;
      if (typeof setEditorText !== "function") return false;
      setEditorText.call(context.ui, draft);
      return true;
    } catch {
      return false;
    }
  };
  const readIdle = (): boolean | null => {
    try {
      const value = context?.isIdle?.call(context);
      return typeof value === "boolean" ? value : null;
    } catch {
      return null;
    }
  };

  const submit = (text: string, as: DeliveredAs, withdrawn: AbortSignal) => {
    let waiter: Waiter | undefined;
    const seen = new Promise<boolean>((resolve) => {
      if (withdrawn.aborted) return resolve(false);
      waiter = { text, as, seen: () => resolve(true) };
      waiters.add(waiter);
      withdrawn.addEventListener("abort", () => resolve(false), { once: true });
    });
    try {
      if (as === "followUp") pi.sendUserMessage(text, { deliverAs: "followUp" });
      else pi.sendUserMessage(text);
    } catch (error) {
      if (waiter) waiters.delete(waiter);
      return Promise.resolve({ status: "refused", detail: `sendUserMessage threw: ${String(error)}` });
    }
    if (as === "followUp") {
      if (waiter) waiters.delete(waiter);
      return Promise.resolve({ status: "delivered", as });
    }
    return seen.then((wasSeen) => {
      if (waiter) waiters.delete(waiter);
      return wasSeen ? { status: "delivered", as } : { status: "refused", detail: "pi never started a turn for the message" };
    });
  };

  return startDeliveryListener({
    socketPath,
    pane,
    harness: "pi",
    callback: callbackTargetFrom(process.env[contract.DELIVERY_CALLBACK_ENV]),
    commands: false,
    tryDeliver: async (request: any, withdrawn: AbortSignal) => {
      if (typeof request.text !== "string") return { status: "refused", detail: "pi takes no commands" };
      const draft = readDraft();
      if (draft === null) return { status: "not-yet", reason: "composer-unreadable" };
      const hasDraft = draft.trim() !== "";
      if (hasDraft && !restoreDraft("")) return { status: "not-yet", reason: "draft" };
      const as: DeliveredAs = readIdle() === false ? "followUp" : "turn";
      const answer = submit(request.text, as, withdrawn);
      if (hasDraft) restoreDraft(draft);
      const settled = await answer;
      log(pi, `${request.id}: ${settled.status}${settled.status === "delivered" ? ` as ${as}` : ""}`);
      return settled;
    },
  });
}
