import { stopHelper } from "./court-agent.mjs";
import { holdTurnRunning, openTimedCourt, statesUntil, waitForAccepted } from "./fire-and-forget.mjs";
import { waitFor } from "./m3-mod-agent.mjs";

const HOLD_SECONDS = 40;
const LOST_CHECK_LIMIT_MS = 150_000;
const LOST_REASON = "stopped answering while it held the accepted message";

export async function check(harness) {
  const { agent, proxy, court, close } = await openTimedCourt(harness, "lost");
  let restoreHelper;
  try {
    const running = await holdTurnRunning(agent, HOLD_SECONDS);
    const id = await court.sendAgent(agent.name, "reply with the single word lost-and-requeued");
    const accepted = await waitForAccepted(proxy);
    const held = await court.messageStatus(id);
    restoreHelper = await stopHelper(agent.socket);
    const notice = await waitFor(async () => {
      const failures = await court.throne(["delivery-failures", "evidence-sender"]);
      return failures.output.includes(LOST_REASON) ? failures.output : undefined;
    }, LOST_CHECK_LIMIT_MS, 5000);
    const states = await statesUntil(court, id, "delivered", 180_000);
    const killed = await restoreHelper();
    restoreHelper = undefined;
    await agent.saveScreen("after");
    const pass = running && accepted && held === "accepted" && Boolean(notice) && states.at(-1) === "delivered";
    return {
      verdict: pass ? "PASS" : "FAIL",
      observed: `message ${id} sent during a ${HOLD_SECONDS}s turn (${running}); the helper answered accepted: ${accepted}; message-status: ${held}; while the agent held it, the helper was killed (${killed} process(es)) and kept from restarting, so the agent stopped answering; the sender's delivery-failures within ${LOST_CHECK_LIMIT_MS / 1000}s: ${notice ? JSON.stringify(notice.trim().split("\n").filter((line) => line.includes(LOST_REASON))) : "no notice"}; message-status of the re-queued message, same id, then read ${states.join(" -> ")}; socket holds: ${proxy.summary()}`,
    };
  } finally {
    await restoreHelper?.();
    await close();
  }
}
