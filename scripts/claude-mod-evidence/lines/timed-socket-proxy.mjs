import net from "node:net";
import { rm } from "node:fs/promises";

export const LONGEST_HOLD_MS = 2000;
export const ACCEPTED_WITHIN_MS = 1000;

export async function startTimedSocketProxy(proxyPath, targetPath) {
  const holds = [];
  const server = net.createServer((client) => {
    const opened = Date.now();
    const hold = { request: "", answer: "", milliseconds: undefined };
    holds.push(hold);
    const upstream = net.connect(targetPath);
    const end = () => {
      if (hold.milliseconds === undefined) hold.milliseconds = Date.now() - opened;
      client.destroy();
      upstream.destroy();
    };
    client.once("data", (piece) => {
      hold.request = piece.toString("utf8").split("\r\n")[0];
    });
    let answered = "";
    upstream.on("data", (piece) => {
      answered += piece.toString("utf8");
      hold.answer = /"status":"([a-z-]+)"/u.exec(answered)?.[1] ?? hold.answer;
    });
    client.pipe(upstream);
    upstream.pipe(client);
    for (const side of [client, upstream]) {
      side.on("close", end);
      side.on("error", end);
    }
  });
  await rm(proxyPath, { force: true });
  await new Promise((resolve) => server.listen(proxyPath, resolve));
  const finished = () => holds.filter((hold) => hold.milliseconds !== undefined);
  return {
    path: proxyPath,
    holds: finished,
    deliveries: () => finished().filter((hold) => hold.request.startsWith("POST /deliver")),
    longest: () => Math.max(0, ...finished().map((hold) => hold.milliseconds)),
    figures: () => ({ holds_ms: finished().map((hold) => hold.milliseconds), longest_hold_ms: Math.max(0, ...finished().map((hold) => hold.milliseconds)) }),
    summary: () => finished().map((hold) => `${hold.request.split(" ").slice(0, 2).join(" ")}${hold.answer === "" ? "" : ` ${hold.answer}`} ${hold.milliseconds}ms`).join(", "),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
