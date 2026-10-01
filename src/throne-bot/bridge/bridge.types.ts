export interface InboundMatrixAttachment {
  mxcUri: string;
  fileName: string;
}

export interface InboundMatrixMessage {
  eventId: string;
  roomId: string;
  senderId: string;
  senderDisplayName: string;
  text: string;
  attachment?: InboundMatrixAttachment;
}

export interface DownloadedAttachment {
  data: Buffer;
  contentType?: string;
}

export interface MatrixSyncClient {
  start(
    onMessage: (message: InboundMatrixMessage) => Promise<void>,
  ): Promise<void>;
  downloadAttachment(mxcUri: string): Promise<DownloadedAttachment>;
}

export interface PaneDeliveryService {
  deliverToPane(botName: string, text: string): Promise<void>;
}

export interface DeliveredEventStore {
  hasDelivered(eventId: string): Promise<boolean>;
  markDelivered(eventId: string): Promise<void>;
}
