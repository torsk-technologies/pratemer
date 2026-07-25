/// <reference types="@cloudflare/workers-types" />
//
// Room = one Durable Object instance per venue. It is the single source of truth
// for that venue's chat: live WebSocket connections, the recent-message buffer,
// and — the important bit — PRESENCE.
//
// Presence model (why nobody stays live after leaving the venue):
//   - A scan mints a session with a HARD cap:  expiresAt = now + sessionTtlMs.
//   - Every message/ping refreshes a SLIDING cap: lastSeen.
//   - A periodic alarm() sweeps sessions where (now > expiresAt) OR
//     (now - lastSeen > idleMs), closes their sockets, and tells the client to
//     re-scan. The only way back in is a fresh scan of the physical sticker.
// The same alarm also auto-deletes messages older than msgTtlMs (ephemerality).

export interface Env {
  ROOM: DurableObjectNamespace;
  ADMIN_SECRET: string;
}

interface Config {
  enabled: boolean; // per-venue kill-switch
  prompt: string; // seeded daily prompt so the room is never empty
  sessionTtlMs: number; // HARD cap: max life of one scan
  idleMs: number; // SLIDING cap: disconnect after this much silence
  msgTtlMs: number; // messages auto-delete after this
  maxMessages: number; // rolling buffer size
  sweepMs: number; // how often the alarm runs
  minMsgGapMs: number; // basic per-session rate limit
}

const DEFAULTS: Config = {
  enabled: true,
  prompt: "Velkommen! Si hei til stemmene rundt deg 👋",
  sessionTtlMs: 90 * 60_000, // 90 min from scan  — tune from the pilot
  idleMs: 15 * 60_000, // 15 min of silence
  msgTtlMs: 3 * 60 * 60_000, // 3 hours
  maxMessages: 100,
  sweepMs: 60_000, // sweep every minute
  minMsgGapMs: 800,
};

interface Session {
  senderId: string; // stable, non-identifying id used for "own message" + mute
  handle: string; // display name
  expiresAt: number; // hard cap
  lastSeen: number; // sliding cap
  lastMsgAt: number; // rate limit
}

interface Msg {
  id: string;
  senderId: string;
  handle: string;
  text: string;
  ts: number;
}

// v1 word filter. Swap for a real list (e.g. a Norwegian + English profanity set).
const BADWORDS = ["badword", "slur1", "slur2"];

const ADJ = ["Stille", "Blid", "Rask", "Lur", "Vill", "Rolig", "Glad", "Kvikk", "Modig", "Snill"];
const NOUN = ["Rev", "Elg", "Ulv", "Ugle", "Bjørn", "Måke", "Hare", "Oter", "Gaupe", "Ørn"];

function randomHandle(): string {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return `${a}${n}${Math.floor(Math.random() * 90) + 10}`;
}

function clean(text: string): string {
  let out = text;
  for (const w of BADWORDS) {
    out = out.replace(new RegExp(w, "gi"), "*".repeat(w.length));
  }
  return out;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export class Room {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  // ---- storage helpers -----------------------------------------------------

  private async getConfig(): Promise<Config> {
    const stored = (await this.ctx.storage.get<Partial<Config>>("config")) ?? {};
    return { ...DEFAULTS, ...stored };
  }

  private async getSessions(): Promise<Record<string, Session>> {
    return (await this.ctx.storage.get<Record<string, Session>>("sessions")) ?? {};
  }

  private async getMessages(): Promise<Msg[]> {
    return (await this.ctx.storage.get<Msg[]>("messages")) ?? [];
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      const cfg = await this.getConfig();
      await this.ctx.storage.setAlarm(Date.now() + cfg.sweepMs);
    }
  }

  private broadcast(obj: unknown, except?: WebSocket): void {
    const payload = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(payload);
      } catch {
        /* socket already gone; alarm will reap it */
      }
    }
  }

  // ---- HTTP entry (called by the Worker, path = the action) ----------------

  async fetch(req: Request): Promise<Response> {
    const action = new URL(req.url).pathname.replace(/^\//, "");
    switch (action) {
      case "join":
        return this.join();
      case "ws":
        return this.connect(req);
      case "admin":
        return this.admin(req);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  // POST /join — a scan. Mints a time-boxed session (the "pass").
  private async join(): Promise<Response> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return json({ error: "disabled" }, 403);

    const now = Date.now();
    const sid = crypto.randomUUID();
    const session: Session = {
      senderId: crypto.randomUUID().slice(0, 8),
      handle: randomHandle(),
      expiresAt: now + cfg.sessionTtlMs,
      lastSeen: now,
      lastMsgAt: 0,
    };
    const sessions = await this.getSessions();
    sessions[sid] = session;
    await this.ctx.storage.put("sessions", sessions);
    await this.ensureAlarm();

    // sid is the bearer token; the DO holds the authoritative record.
    return json({
      sid,
      senderId: session.senderId,
      handle: session.handle,
      expiresAt: session.expiresAt,
    });
  }

  // GET /ws?sid=... — upgrade to WebSocket, validated against the session.
  private async connect(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const sid = new URL(req.url).searchParams.get("sid") ?? "";
    const cfg = await this.getConfig();
    const sessions = await this.getSessions();
    const session = sessions[sid];
    const now = Date.now();

    if (!cfg.enabled) return json({ error: "disabled" }, 403);
    if (!session || now > session.expiresAt) return json({ error: "expired" }, 401);

    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernation API: survives DO eviction; attachment ties socket -> session.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid });

    session.lastSeen = now;
    sessions[sid] = session;
    await this.ctx.storage.put("sessions", sessions);
    await this.ensureAlarm();

    const messages = await this.getMessages();
    server.send(
      JSON.stringify({
        type: "welcome",
        senderId: session.senderId,
        handle: session.handle,
        expiresAt: session.expiresAt,
        prompt: cfg.prompt,
        messages,
      })
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket hibernation handlers --------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as { sid: string } | null;
    if (!att) return ws.close(1008, "no session");

    const cfg = await this.getConfig();
    const sessions = await this.getSessions();
    const session = sessions[att.sid];
    const now = Date.now();

    // Re-validate presence on every message (hard + kill-switch).
    if (!session || now > session.expiresAt) {
      try {
        ws.send(JSON.stringify({ type: "expired", reason: "session" }));
      } catch {}
      return ws.close(1000, "expired");
    }
    if (!cfg.enabled) {
      try {
        ws.send(JSON.stringify({ type: "paused", text: "Praten er satt på pause av stedet." }));
      } catch {}
      return ws.close(1000, "disabled");
    }

    if (data.type === "ping") {
      session.lastSeen = now; // refresh sliding window
      sessions[att.sid] = session;
      await this.ctx.storage.put("sessions", sessions);
      return;
    }

    if (data.type === "report" && typeof data.id === "string") {
      // v1: just log. TODO: alert operator / auto-hide after N reports.
      console.log(`[report] room msg=${data.id} by=${session.senderId}`);
      return;
    }

    if (data.type === "msg" && typeof data.text === "string") {
      const text = clean(data.text.trim().slice(0, 500));
      if (!text) return;
      if (now - session.lastMsgAt < cfg.minMsgGapMs) {
        ws.send(JSON.stringify({ type: "system", text: "Rolig nå — vent litt før neste melding." }));
        return;
      }

      const msg: Msg = {
        id: crypto.randomUUID(),
        senderId: session.senderId,
        handle: session.handle,
        text,
        ts: now,
      };

      let messages = await this.getMessages();
      messages.push(msg);
      messages = messages
        .filter((m) => now - m.ts < cfg.msgTtlMs)
        .slice(-cfg.maxMessages);
      await this.ctx.storage.put("messages", messages);

      session.lastSeen = now;
      session.lastMsgAt = now;
      sessions[att.sid] = session;
      await this.ctx.storage.put("sessions", sessions);

      this.broadcast({ type: "msg", msg });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // Keep the session record until it expires so brief network drops can
    // reconnect (supports the sliding window). The alarm reaps stale ones.
    try {
      ws.close();
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {}
  }

  // ---- the sweep: presence + ephemerality ----------------------------------

  async alarm(): Promise<void> {
    const cfg = await this.getConfig();
    const now = Date.now();

    // 1) Ephemeral messages: drop anything past TTL.
    const messages = (await this.getMessages()).filter((m) => now - m.ts < cfg.msgTtlMs);
    await this.ctx.storage.put("messages", messages);

    // 2) Presence sweep: hard cap OR idle cap => gone.
    const sessions = await this.getSessions();
    const gone = new Set<string>();
    for (const [sid, s] of Object.entries(sessions)) {
      if (now > s.expiresAt || now - s.lastSeen > cfg.idleMs) {
        gone.add(sid);
        delete sessions[sid];
      }
    }
    await this.ctx.storage.put("sessions", sessions);

    // Close any live sockets belonging to swept sessions.
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as { sid: string } | null;
      if (att && gone.has(att.sid)) {
        try {
          ws.send(JSON.stringify({ type: "expired", reason: "left-venue" }));
          ws.close(1000, "expired");
        } catch {}
      }
    }

    // Reschedule while there is anything left to watch.
    const remaining = Object.keys(sessions).length + this.ctx.getWebSockets().length;
    if (remaining > 0 || messages.length > 0) {
      await this.ctx.storage.setAlarm(now + cfg.sweepMs);
    }
  }

  // ---- admin: kill-switch + daily prompt -----------------------------------

  private async admin(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const secret = req.headers.get("x-admin-secret") ?? url.searchParams.get("secret");
    if (!this.env.ADMIN_SECRET || secret !== this.env.ADMIN_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const cfg = await this.getConfig();

    if (req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Partial<Config>;
      if (typeof body.enabled === "boolean") cfg.enabled = body.enabled;
      if (typeof body.prompt === "string") cfg.prompt = body.prompt.slice(0, 200);
      await this.ctx.storage.put("config", cfg);

      if (cfg.enabled === false) {
        this.broadcast({ type: "paused", text: "Praten er satt på pause av stedet." });
        for (const ws of this.ctx.getWebSockets()) {
          try {
            ws.close(1000, "disabled");
          } catch {}
        }
      }
      return json({ ok: true, config: cfg });
    }

    const sessions = await this.getSessions();
    return json({
      config: cfg,
      activeSessions: Object.keys(sessions).length,
      sockets: this.ctx.getWebSockets().length,
    });
  }
}
