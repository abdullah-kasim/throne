# Web app
Summary: Serves one React app with a route per tool on loopback and publishes it on the tailnet.
Code: web, src/web-listener, src/web-api-contract
Search words: web, tailscale, vite

## What it does

The Vite and React app under `web/` is built into `dist/web/` and served with `/api/<tool>/` by the web listener inside the backend on loopback port 8430, and published at `/throne` on the tailnet. Request and response schemas are shared from `src/web-api-contract/`. A failed bind or missing tailscale never stops the backend.

## Sub-features

- WEB-LOOPBACK: The listener binds loopback only.
- WEB-TAILNET: Publishing is tailnet only.
- WEB-TOOL: A tool is a feature folder plus one entry in tools.tsx.

## How to reach it and prove it works

```
bun test ./src/web-listener/web-listener.spec.ts
```

And `bun run test:web` runs the app's own tests.

## Gotchas

THRONE_WEB_PORT overrides the port.
