import type { PreviewEntry } from "../previews/preview-entries.ts";
import { WEB_APP_MOUNT_PATH } from "../web-api-contract/web-app-mount.ts";
import {
  FOLDER_PREVIEWS_PATH,
  MOVED_WHERE_I_STAND_PATH,
  OLD_WHERE_I_STAND_PATH,
  TAILNET_DEFAULT_HTTPS_PORT,
  webListenerAddress,
} from "./web-listener-address.ts";

const WHOLE_PORT_PATH = "/";

export interface TailnetPlace {
  readonly httpsPort: number;
  readonly path: string;
}

export interface TailnetRoute extends TailnetPlace {
  readonly target: string;
}

export function placeOfPreview(preview: Pick<PreviewEntry, "path" | "port">): TailnetPlace {
  return { httpsPort: preview.port ?? TAILNET_DEFAULT_HTTPS_PORT, path: preview.path ?? WHOLE_PORT_PATH };
}

export function folderPreviewName(preview: PreviewEntry): string {
  const { httpsPort, path } = placeOfPreview(preview);
  return path === WHOLE_PORT_PATH ? String(httpsPort) : `${httpsPort}-${path.slice(1)}`;
}

export function routeOfPreview(preview: PreviewEntry, listenerPort: number): TailnetRoute {
  const folderRoute = `${webListenerAddress(listenerPort)}${FOLDER_PREVIEWS_PATH}/${folderPreviewName(preview)}`;
  return { ...placeOfPreview(preview), target: preview.address ?? folderRoute };
}

export function wantedTailnetRoutes(listenerPort: number, previews: readonly PreviewEntry[]): readonly TailnetRoute[] {
  const listener = webListenerAddress(listenerPort);
  return [
    { httpsPort: TAILNET_DEFAULT_HTTPS_PORT, path: WEB_APP_MOUNT_PATH, target: listener },
    {
      httpsPort: TAILNET_DEFAULT_HTTPS_PORT,
      path: OLD_WHERE_I_STAND_PATH,
      target: `${listener}${MOVED_WHERE_I_STAND_PATH}`,
    },
    ...previews.map((preview) => routeOfPreview(preview, listenerPort)),
  ];
}

export function isSameTailnetPlace(first: TailnetPlace, second: TailnetPlace): boolean {
  return first.httpsPort === second.httpsPort && first.path === second.path;
}
