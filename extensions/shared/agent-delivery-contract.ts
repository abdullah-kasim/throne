export const DELIVERY_SOCKET_ENV = "THRONE_DELIVERY_SOCKET";
export const DELIVERY_RUNTIME_ENV = "THRONE_DELIVERY_RUNTIME";
export const DELIVERY_HELPER_ENV = "THRONE_DELIVERY_HELPER";
export const DELIVERY_CALLBACK_ENV = "THRONE_DELIVERY_CALLBACK";

export const SENDER_MARGIN_MILLISECONDS = 2000;
export const CONNECT_TIMEOUT_MILLISECONDS = 1000;
export const ALIVE_TIMEOUT_MILLISECONDS = 1000;
export const BODY_READ_TIMEOUT_MILLISECONDS = 5000;
export const MOD_REPORT_TIMEOUT_MILLISECONDS = 5000;
export const HELPER_LISTEN_TIMEOUT_MILLISECONDS = 5000;
export const RETRY_INTERVAL_MILLISECONDS = 250;
export const REMEMBERED_DELIVERED_IDS = 500;
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_SOCKET_PATH_BYTES = 100;
export const CALLBACK_RETRY_INTERVAL_MILLISECONDS = 2000;
export const CALLBACK_RETRY_WINDOW_MILLISECONDS = 120000;

export const MESSAGE_ID_PREFIX = "message-";
export const COMMAND_ID_PREFIX = "command-";

export const DELIVER_PATH = "/deliver";
export const ALIVE_PATH = "/alive";
export const RESULT_PATH = "/result";
export const DELIVERY_CALLBACK_PATH = "/api/delivery-callback";

export type DeliveryHarness = "claude" | "pi";
export type DeliveredAs = "turn" | "followUp";
export type BusyReason = "draft" | "turn-running" | "composer-unreadable";

export type MessageRequest = {
  id: string;
  pane: string;
  text: string;
  waitMs: number;
  acknowledge?: true;
};

export type CommandRequest = {
  id: string;
  pane: string;
  command: string;
  args: string;
  waitMs: number;
};

export type DeliveryRequest = MessageRequest | CommandRequest;

export type DeliveredAnswer = {
  id: string;
  pane: string;
  status: "delivered";
  as: DeliveredAs;
  repeat?: true;
};

export type BusyAnswer = {
  id: string;
  pane: string;
  status: "busy";
  reason: BusyReason;
};

export type RefusedAnswer = {
  id: string;
  pane: string;
  status: "refused";
  detail: string;
};

export type AcceptedAnswer = {
  id: string;
  pane: string;
  status: "accepted";
};

export type DeliveryAnswer = DeliveredAnswer | AcceptedAnswer | BusyAnswer | RefusedAnswer;

export type DeliveryCallback = {
  id: string;
  pane: string;
  status: "delivered" | "refused";
  as?: DeliveredAs;
  detail?: string;
};

export type AliveAnswer = {
  pane: string;
  harness: DeliveryHarness;
  commands: boolean;
  callbacks?: true;
};
