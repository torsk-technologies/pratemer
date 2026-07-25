import { useEffect, useMemo, useRef, useState } from "react";

// ---- types shared with the Room DO ----
interface Msg {
  id: string;
  senderId: string;
  handle: string;
  text: string;
  ts: number;
}
interface Token {
  sid: string;
  senderId: string;
  handle: string;
  expiresAt: number;
}

type Status = "connecting" | "live" | "expired" | "disabled" | "error";

// venueId comes from the QR: https://app/v/:venueId
function venueFromPath(): string {
  const m = window.location.pathname.match(/^\/v\/([\w-]+)/);
  return m ? m[1] : "demo";
}

const tokenKey = (v: string) => `pratemer:${v}`;
const muteKey = (v: string) => `pratemer:mute:${v}`;

export function App() {
  const venueId = useMemo(venueFromPath, []);
  const [status, setStatus] = useState<Status>("connecting");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [prompt, setPrompt] = useState("");
  const [me, setMe] = useState<Token | null>(null);
  const [muted, setMuted] = useState<Set<string>>(
    () => new Set(JSON.parse(localStorage.getItem(muteKey(venueFromPath())) || "[]"))
  );
  const [draft, setDraft] = useState("");
  const [remaining, setRemaining] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // --- session: reuse a still-valid token, else "scan" (join) ---
  async function ensureToken(): Promise<Token> {
    const raw = localStorage.getItem(tokenKey(venueId));
    if (raw) {
      const t = JSON.parse(raw) as Token;
      if (t.expiresAt > Date.now() + 5_000) return t;
    }
    const res = await fetch(`/api/room/${venueId}/join`, { method: "POST" });
    if (!res.ok) throw new Error("join failed");
    const t = (await res.json()) as Token;
    localStorage.setItem(tokenKey(venueId), JSON.stringify(t));
    return t;
  }

  function clearToken() {
    localStorage.removeItem(tokenKey(venueId));
  }

  // --- connect ---
  useEffect(() => {
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    (async () => {
      try {
        const t = await ensureToken();
        if (cancelled) return;
        setMe(t);

        const proto = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${proto}://${location.host}/api/room/${venueId}/ws?sid=${t.sid}`);
        wsRef.current = ws;

        ws.onopen = () => {
          heartbeat = setInterval(() => {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {}
          }, 30_000);
        };

        ws.onmessage = (ev) => {
          const data = JSON.parse(ev.data);
          if (data.type === "welcome") {
            setStatus("live");
            setPrompt(data.prompt);
            setMessages(data.messages ?? []);
          } else if (data.type === "msg") {
            setMessages((prev) => [...prev, data.msg]);
          } else if (data.type === "system") {
            setMessages((prev) => [
              ...prev,
              { id: crypto.randomUUID(), senderId: "system", handle: "System", text: data.text, ts: Date.now() },
            ]);
          } else if (data.type === "paused") {
            // Venue flipped the kill-switch while we were live.
            setStatus("disabled");
          } else if (data.type === "expired") {
            clearToken();
            setStatus("expired");
          }
        };

        ws.onclose = (ev) => {
          if (cancelled) return;
          // Fallback if the explicit signal didn't arrive before the close.
          if (ev.reason === "disabled") setStatus("disabled");
          else if (ev.reason === "expired") {
            clearToken();
            setStatus("expired");
          } else if (status === "connecting") setStatus("error");
        };
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (heartbeat) clearInterval(heartbeat);
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId]);

  // --- local countdown to the hard cap (also flips UI to "expired") ---
  useEffect(() => {
    if (!me) return;
    const tick = () => {
      const left = me.expiresAt - Date.now();
      setRemaining(left);
      if (left <= 0) {
        clearToken();
        setStatus("expired");
      }
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  // --- autoscroll ---
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  function send() {
    const text = draft.trim();
    if (!text || status !== "live") return;
    wsRef.current?.send(JSON.stringify({ type: "msg", text }));
    setDraft("");
  }

  function report(id: string) {
    wsRef.current?.send(JSON.stringify({ type: "report", id }));
  }

  function toggleMute(senderId: string) {
    setMuted((prev) => {
      const next = new Set(prev);
      next.has(senderId) ? next.delete(senderId) : next.add(senderId);
      localStorage.setItem(muteKey(venueId), JSON.stringify([...next]));
      return next;
    });
  }

  function rescan() {
    clearToken();
    window.location.reload();
  }

  const mmss = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  // --- expired / paused screens: the "you left the venue" wall ---
  if (status === "expired") {
    return (
      <Center>
        <h1>Praten er tidsavløpt</h1>
        <p>Skann QR-koden på bordet igjen for å bli med på nytt.</p>
        <button onClick={rescan}>Skann på nytt</button>
      </Center>
    );
  }
  if (status === "disabled") {
    return (
      <Center>
        <h1>Praten er på pause</h1>
        <p>Stedet har midlertidig slått av praten.</p>
        <button onClick={rescan}>Prøv igjen</button>
      </Center>
    );
  }
  if (status === "error") {
    return (
      <Center>
        <h1>Noe gikk galt</h1>
        <button onClick={rescan}>Prøv igjen</button>
      </Center>
    );
  }

  return (
    <div className="app">
      <header>
        <div>
          <strong>#{venueId}</strong>
          <span className="handle">{me?.handle}</span>
        </div>
        <span className="timer" title="Tid igjen før du må skanne på nytt">
          ⏱ {mmss(remaining)}
        </span>
      </header>

      {prompt && <div className="prompt">💬 {prompt}</div>}

      <div className="list" ref={listRef}>
        {status === "connecting" && <p className="muted">Kobler til …</p>}
        {messages.map((m) => {
          if (muted.has(m.senderId)) return null;
          const mine = m.senderId === me?.senderId;
          const system = m.senderId === "system";
          return (
            <div key={m.id} className={`msg ${mine ? "mine" : ""} ${system ? "system" : ""}`}>
              {!mine && !system && <span className="from">{m.handle}</span>}
              <span className="text">{m.text}</span>
              {!mine && !system && (
                <span className="actions">
                  <button onClick={() => report(m.id)} title="Rapporter">⚑</button>
                  <button onClick={() => toggleMute(m.senderId)} title="Demp">🔇</button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      <footer>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Skriv en melding …"
          maxLength={500}
          disabled={status !== "live"}
        />
        <button onClick={send} disabled={status !== "live" || !draft.trim()}>
          Send
        </button>
      </footer>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <div className="center">
      <div>{children}</div>
    </div>
  );
}
