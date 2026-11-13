import { parseArgs } from "node:util";
import { PINNED_NOW, seedFixtureHome } from "./fixture.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string" },
    "data-home": { type: "string" },
    "cache-home": { type: "string" },
    "web-root": { type: "string" },
    "seed-only": { type: "boolean", default: false },
    "markdown-only": { type: "boolean", default: false },
  },
});

const dataHome = values["data-home"]!;
const cacheHome = values["cache-home"]!;
await seedFixtureHome(dataHome, cacheHome, { database: !values["markdown-only"] });
if (values["seed-only"]) process.exit(0);

process.env.THRONE_DATA_HOME = dataHome;
process.env.XDG_CACHE_HOME = cacheHome;
const { whereIStandClock } = await import("../../src/where-i-stand-store/where-i-stand.store.ts");
whereIStandClock.now = () => new Date(PINNED_NOW);
const { startWebListener } = await import("../../src/web-listener/web-listener-app.ts");
const listener = await startWebListener({ port: Number(values.port), webRoot: values["web-root"]! });
console.log(`listening on ${values.port}`);
const stop = async () => {
  await listener.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
