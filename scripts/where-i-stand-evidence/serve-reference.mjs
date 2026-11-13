import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    tree: { type: "string" },
    port: { type: "string" },
    "data-home": { type: "string" },
    "cache-home": { type: "string" },
  },
});

process.env.THRONE_DATA_HOME = values["data-home"];
process.env.XDG_CACHE_HOME = values["cache-home"];
const { startWebListener } = await import(path.join(values.tree, "dist", "src", "web-listener", "web-listener-app.js"));
const listener = await startWebListener({ port: Number(values.port), webRoot: path.join(values.tree, "dist", "web") });
console.log(`listening on ${values.port}`);
const stop = async () => {
  await listener.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
