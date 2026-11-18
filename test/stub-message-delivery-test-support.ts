import type { MessageDeliveryHandlerDeps } from "../src/throne-work/message-delivery-handler.ts";

export function stubMessageDelivery(
  overrides: Partial<MessageDeliveryHandlerDeps> = {},
): MessageDeliveryHandlerDeps {
  return {
    resolveAgent: async () => ({}) as never,
    submitToAgent: async () => {},
    clearBlockedState: async () => {},
    readAgentRole: async () => ({ status: "absent" }) as never,
    readAgentSupervisor: async () => ({ status: "absent" }) as never,
    recordDeliveredEvent: async () => {},
    sleep: async () => {},
    maxNotSentAttempts: 1,
    ...overrides,
  };
}
