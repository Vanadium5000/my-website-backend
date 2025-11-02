// Backend: src/webhooks/index.ts (webhook boilerplate/objects)

import { Server as Engine } from "@socket.io/bun-engine";

export const engine = new Engine({
  path: "/sockets/", // Changed to /sockets/ for namespaced routes
});

export const { websocket } = engine.handler();
