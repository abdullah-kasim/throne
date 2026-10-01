import { resolveAgent } from '../../herdr/herdr-runtime.service.ts';
import { submitToAgent } from '../../herdr/herdr-send.service.ts';
import type { PaneDeliveryService } from './bridge.types.ts';

export function createPaneDeliveryService(): PaneDeliveryService {
  return {
    async deliverToPane(botName: string, text: string): Promise<void> {
      const recipient = await resolveAgent(botName);
      await submitToAgent(recipient, '', text, {
        omitSenderAttribution: true,
      });
    },
  };
}
