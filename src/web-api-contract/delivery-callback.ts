import { z } from "zod";

export const deliveryCallbackRequest = z.object({
  id: z.string().min(1),
  pane: z.string().min(1),
  status: z.enum(["delivered", "refused"]),
  as: z.enum(["turn", "followUp"]).optional(),
  detail: z.string().optional(),
});

export type DeliveryCallbackRequest = z.infer<typeof deliveryCallbackRequest>;
