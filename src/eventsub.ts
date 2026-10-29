/** Offizieller EventSub-WebSocket von Twitch */
export const EVENTSUB_WS_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

export interface EventSubHandlers {
  /**
   * Neue Sitzung ohne Abos: Jetzt abonnieren, Twitch schließt die Verbindung
   * sonst nach 10 Sekunden. Wirft der Handler, wird neu verbunden.
   */
  onSession(sessionId: string): Promise<void>;
  /** `timestamp` ist der Zeitpunkt, zu dem Twitch das Ereignis verschickt hat (ISO). */
  onEvent(type: string, event: any, timestamp: string): void;
  /** Verbindung verloren; bis zur nächsten onSession können Ereignisse fehlen. */
  onDisconnect(reason: string): void;
  /** Twitch hat ein Abo beendet, z. B. weil die Anmeldung widerrufen wurde. */
  onRevocation(type: string, status: string): void;
}

/** Das Nötigste von WebSocket, damit sich der Client im Test ersetzen lässt. */
export interface SocketLike {
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface EventSubConnection {
  close(): void;
}

/** Wie viele Nachrichten-IDs für die Duplikat-Erkennung gemerkt werden */
const SEEN_LIMIT = 2000;

/**
 * Hält eine EventSub-WebSocket-Verbindung offen: abonniert nach jeder neuen
 * Sitzung, folgt Twitchs Umzugsaufforderungen (session_reconnect) ohne
 * Lücke, verbindet sich nach Abbrüchen oder ausbleibendem Keepalive mit
 * wachsendem Abstand neu und filtert doppelt zugestellte Nachrichten.
 */
export function connectEventSub(
  handlers: EventSubHandlers,
  url = EVENTSUB_WS_URL,
  createSocket: (url: string) => SocketLike = (u) => new WebSocket(u) as unknown as SocketLike,
): EventSubConnection {
  let active: SocketLike | undefined;
  let stopped = false;
  let failures = 0;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();

  const lost = (reason: string) => {
    clearTimeout(watchdog);
    const old = active;
    active = undefined;
    if (old) {
      // Ohne Handler, sonst meldet ihr close den Abbruch ein zweites Mal.
      old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
    if (stopped) return;
    handlers.onDisconnect(reason);
    const delay = Math.min(60_000, 1000 * 2 ** failures++);
    retry = setTimeout(() => open(url, false), delay);
  };

  const open = (target: string, migrating: boolean) => {
    const ws = createSocket(target);
    let keepaliveMs = 40_000;
    const arm = () => {
      if (ws !== active) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => lost("Keepalive von Twitch ausgeblieben"), keepaliveMs);
    };

    ws.onmessage = ({ data }) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const meta = msg.metadata ?? {};
      const payload = msg.payload ?? {};

      if (meta.message_type === "session_welcome") {
        const session = payload.session ?? {};
        keepaliveMs = ((Number(session.keepalive_timeout_seconds) || 30) + 10) * 1000;
        const previous = active;
        active = ws;
        arm();
        if (migrating) {
          // Abos ziehen mit um, die alte Verbindung erst jetzt schließen.
          if (previous && previous !== ws) previous.close();
          failures = 0;
          return;
        }
        handlers.onSession(String(session.id)).then(
          () => (failures = 0),
          (err) => lost(`Abonnieren fehlgeschlagen: ${err.message}`),
        );
        return;
      }
      if (ws !== active) return;
      arm();

      if (meta.message_id) {
        if (seen.has(meta.message_id)) return;
        seen.add(meta.message_id);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      }

      switch (meta.message_type) {
        case "notification":
          handlers.onEvent(String(meta.subscription_type ?? payload.subscription?.type), payload.event, String(meta.message_timestamp));
          break;
        case "session_reconnect":
          open(String(payload.session?.reconnect_url), true);
          break;
        case "revocation":
          handlers.onRevocation(String(payload.subscription?.type), String(payload.subscription?.status));
          break;
      }
    };
    // Nach einem gescheiterten Handshake kommt in Node nur error, kein close.
    let gone = false;
    const end = (reason: string) => {
      if (gone) return;
      gone = true;
      if (ws === active) lost(reason);
      else if (!active && !stopped && !migrating) lost(reason);
    };
    ws.onclose = ({ code, reason }) => end(`Verbindung geschlossen (${code}${reason ? `: ${reason}` : ""})`);
    ws.onerror = (ev: any) => end(`Verbindungsfehler${ev?.message ? `: ${ev.message}` : ""}`);
  };

  open(url, false);
  return {
    close() {
      stopped = true;
      clearTimeout(watchdog);
      clearTimeout(retry);
      active?.close();
      active = undefined;
    },
  };
}
