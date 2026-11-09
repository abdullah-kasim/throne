export const WEB_PORT_ENVIRONMENT_VARIABLE = "THRONE_WEB_PORT";
export const WEB_LISTENER_HOST = "127.0.0.1";
export const OLD_WHERE_I_STAND_PATH = "/where-i-stand";
export const MOVED_WHERE_I_STAND_PATH = "/moved/where-i-stand";
export const FOLDER_PREVIEWS_PATH = "/previews";
export const TAILNET_DEFAULT_HTTPS_PORT = 443;

const DEFAULT_WEB_PORT = 8430;

export function webListenerPort(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return Number(environment[WEB_PORT_ENVIRONMENT_VARIABLE] || DEFAULT_WEB_PORT);
}

export function queryOf(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? "" : url.slice(queryStart);
}

export function webListenerAddress(port: number): string {
  return `http://${WEB_LISTENER_HOST}:${port}`;
}
