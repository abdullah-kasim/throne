import { armHardKillTimer } from "./sqlite-delivery-sandbox.ts";

const hardKillMs = Number(process.env.THRONE_TEST_HARD_KILL_TTL_MS ?? "300");

armHardKillTimer(hardKillMs);
await new Promise<never>(() => {});
