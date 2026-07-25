/// <reference types="@cloudflare/workers-types" />
//
// Thin front door. Two jobs:
//   1. /api/room/:venueId/<action>  -> route to that venue's Durable Object.
//   2. everything else              -> serve the built React app (SPA).

import { Room } from "./room";

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["api","room",venueId,action]
      if (parts[1] === "room" && parts[2]) {
        const venueId = parts[2];
        const action = parts[3] ?? "";

        // Address the one DO instance for this venue by name.
        const stub = env.ROOM.get(env.ROOM.idFromName(venueId));

        // Forward with the path rewritten to just the action.
        const doUrl = new URL(req.url);
        doUrl.pathname = "/" + action;
        return stub.fetch(new Request(doUrl, req));
      }
      return new Response("Not found", { status: 404 });
    }

    // Static assets + SPA fallback (configured in wrangler.toml).
    return env.ASSETS.fetch(req);
  },
};
