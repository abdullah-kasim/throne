import { mkdirSync } from "node:fs";
import path from "node:path";

const repositoryRoot = process.argv[2];
const { createTransportServer, resolveTransportSocketPath } = await import(
  path.join(repositoryRoot, "dist/src/transport/transport-wire-contract.js")
);
const { buildProductionRouteHandlers } = await import(
  path.join(repositoryRoot, "dist/src/throne-backend/transport-route-dispatcher.js")
);

const socketPath = resolveTransportSocketPath();
mkdirSync(path.dirname(socketPath), { recursive: true });
const server = createTransportServer({
  routeHandlers: buildProductionRouteHandlers(),
  resolveServerGeneration: () => undefined,
});
server.listen(socketPath, () => console.log(`listening pid=${process.pid}`));
