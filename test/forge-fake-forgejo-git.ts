import { execFile, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function gitInBare(directory: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    return { ok: true, stdout: (await execFileAsync("git", [...args], { cwd: directory, encoding: "utf8" })).stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

export function serveGitOverHttp(request: IncomingMessage, response: ServerResponse, projectRoot: string, pathInfo: string, query: string, remoteUser: string): void {
  const backend = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      REQUEST_METHOD: request.method ?? "GET",
      QUERY_STRING: query,
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
      REMOTE_USER: remoteUser,
      REMOTE_ADDR: "127.0.0.1",
    },
  });
  request.pipe(backend.stdin);
  const output: Buffer[] = [];
  backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  backend.on("close", () => {
    const raw = Buffer.concat(output);
    const split = raw.indexOf("\r\n\r\n");
    const headerText = raw.subarray(0, split).toString("utf8");
    const headers: Record<string, string> = {};
    let status = 200;
    for (const line of headerText.split("\r\n")) {
      const [name, ...rest] = line.split(":");
      const value = rest.join(":").trim();
      if (name!.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name!] = value;
    }
    response.writeHead(status, headers);
    response.end(raw.subarray(split + 4));
  });
}
