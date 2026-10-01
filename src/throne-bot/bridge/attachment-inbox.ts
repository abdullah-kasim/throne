import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DownloadedAttachment } from './bridge.types.ts';

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

export function attachmentExtension(
  contentType: string | undefined,
  fileName: string,
): string {
  const fromFileName = extname(fileName);
  if (fromFileName !== '') return fromFileName;
  if (contentType !== undefined && contentType in CONTENT_TYPE_EXTENSIONS) {
    return CONTENT_TYPE_EXTENSIONS[contentType];
  }
  return '';
}

export function attachmentInboxPath(
  botName: string,
  eventId: string,
  extension: string,
): string {
  return join(
    homedir(),
    '.throne-bot',
    'data',
    botName,
    'inbox',
    `${eventId}${extension}`,
  );
}

export async function saveAttachmentToInbox(
  botName: string,
  eventId: string,
  attachment: DownloadedAttachment,
  fileName: string,
): Promise<string> {
  const extension = attachmentExtension(attachment.contentType, fileName);
  const path = attachmentInboxPath(botName, eventId, extension);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, attachment.data);
  return path;
}
