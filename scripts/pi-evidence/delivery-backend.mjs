import { appendFile } from "node:fs/promises";
import { openMessageQueueStore } from "../../src/message-queue/message-queue.store.ts";
import { MESSAGE_DELIVERY_WORK_ITEM_KIND } from "../../src/send-agent/message-delivery-enqueue.ts";
import { deliverMessageWorkItem } from "../../src/throne-work/message-delivery-handler.ts";
import { reclaimOrphanedInFlightWorkItemsAsAssumedFilled } from "../../src/throne-work/dispatch-loop.ts";
import { submitToAgent } from "../../src/herdr/herdr-send.service.ts";
import { buildSubmitToAgentDeps } from "../../src/herdr/herdr-send-enter-until-empty.ts";
import { resolveAgent } from "../../src/herdr/herdr-runtime.service.ts";
import { listAgentsInSession } from "../../src/herdr/herdr-runtime-session-reads.ts";
import { deliverToPi } from "../../src/herdr/pi-delivery-client.ts";
import { startDeliveryCallbackListener } from "../../src/delivery-callback/delivery-callback.hosted-worker.ts";

const settings = JSON.parse(process.argv[2]);
const store = openMessageQueueStore(settings.databasePath);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function refuse(kind) {
  return async (paneId) => {
    await appendFile(settings.refusalLog, `${kind} ${paneId}\n`);
    throw new Error(`the evidence herdr client refuses ${kind} for pi pane ${paneId}`);
  };
}

const deliverToRecordedSocket = (text, timeoutMs, recipient, messageId) =>
  deliverToPi(text, timeoutMs, recipient, messageId, settings.sockets?.[recipient.agentName] === undefined ? {} : { socketPath: settings.sockets[recipient.agentName] });

const typingDeps = { ...buildSubmitToAgentDeps(settings.sessionName), deliverToPi: deliverToRecordedSocket };

const piOnlyDeps = {
  ...buildSubmitToAgentDeps(settings.sessionName),
  sendText: refuse("send-text"),
  pressEnter: refuse("send-keys"),
  pressPaneKey: refuse("send-keys"),
  readVisibleAgentAnsi: refuse("agent read"),
  readRecentAgentAnsi: refuse("agent read"),
  readVisibleCodexAgentAnsi: refuse("agent read"),
  readRecentCodexAgentAnsi: refuse("agent read"),
  fileBackedPayloadsEnabled: () => false,
  deliverToPi: deliverToRecordedSocket,
};

const submitDeps = settings.typing === true ? typingDeps : piOnlyDeps;

const handlerDeps = {
  resolveAgent: (name) => resolveAgent(name, { listAgents: () => listAgentsInSession(settings.sessionName) }),
  submitToAgent: (agent, senderName, prompt, options) =>
    submitToAgent(agent, senderName, prompt, { ...options, composerWaitMilliseconds: settings.waitMilliseconds }, submitDeps),
  clearBlockedState: async () => undefined,
  readAgentRole: async () => ({ status: "field-absent" }),
  readAgentSupervisor: async () => ({ status: "field-absent" }),
  recordDeliveredEvent: async () => undefined,
  markAgentTasked: async () => undefined,
  appendSentMessageLedgerEntry: async () => undefined,
  now: Date.now,
  sleep: pause,
  maxNotSentAttempts: 1,
};

reclaimOrphanedInFlightWorkItemsAsAssumedFilled(store);
if (settings.callbackSocket !== undefined) await startDeliveryCallbackListener(settings.callbackSocket, () => openMessageQueueStore(settings.databasePath));
process.stdout.write("backend ready\n");
for (;;) {
  const item = store.claimNextDueWorkItem([MESSAGE_DELIVERY_WORK_ITEM_KIND]);
  if (item === undefined) {
    await pause(200);
    continue;
  }
  const finished = await deliverMessageWorkItem(store, item, handlerDeps);
  process.stdout.write(`message ${finished.id} ${finished.state} ${finished.failureReason ?? ""}\n`);
}
