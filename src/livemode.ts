import { connectEventSub, EVENTSUB_WS_URL, type SocketLike } from "./eventsub.ts";
import type { AnalysisResult } from "./pipeline.ts";
import { LiveRecorder, type RecorderOptions, type RecorderStatus } from "./recorder.ts";
import { CHAT_SCOPE, checkAuth, subscribeEventSub } from "./twitch.ts";

/** Abgleich mit dem Stream-Status, falls ein online/offline-Ereignis verloren ging */
const SYNC_INTERVAL_MS = 5 * 60_000;
/** Twitch verlangt, das Token mindestens stündlich zu prüfen */
const VALIDATE_INTERVAL_MS = 60 * 60_000;
/** So viele Protokollzeilen behält der Status für die Oberfläche */
const LOG_LINES = 30;

export interface LiveStatus {
  /** connecting/disconnected: keine Verbindung zu Twitch, error: gestoppt, siehe message */
  state: "connecting" | "disconnected" | "error" | RecorderStatus["state"];
  message?: string;
  /** Verbindung zu Twitch steht; fehlt sie während eines Streams, entsteht eine Lücke */
  connected: boolean;
  channel?: string;
  stream?: RecorderStatus["stream"];
  analyzeAt?: string;
  /** Zuletzt automatisch ausgewertet */
  last?: { id: string; title?: string; highlights: number; at: string };
  log: string[];
}

export interface LiveService {
  status(): LiveStatus;
  /** Schließt den Mitschnitt; er wird beim nächsten Start fortgesetzt. */
  stop(): Promise<void>;
  /** Eine Zeile ins Protokoll des Mitschnitts schreiben (z. B. Einrichtung, Nachholen) */
  log(line: string): void;
}

export interface LiveServiceOptions extends RecorderOptions {
  /** Twitch hat die Anmeldung widerrufen, der Dienst hat sich beendet */
  onFatal?: (message: string) => void;
  /** Für Tests */
  createSocket?: (url: string) => SocketLike;
}

/**
 * Startet den Live-Mitschnitt: Verbindung zu EventSub, Abos für den eigenen
 * Kanal, regelmäßiger Abgleich und Token-Prüfung. Wirft, wenn die Anmeldung
 * fehlt oder den Chat nicht lesen darf. Genutzt von `npm run live` (Server)
 * und vom Schalter in der Oberfläche (.exe).
 */
export async function startLive(opts: LiveServiceOptions): Promise<LiveService> {
  const auth = await checkAuth(opts.authPath).catch((err) => {
    throw err.message === "fetch failed" ? new Error("Twitch ist nicht erreichbar. Besteht eine Internetverbindung?") : err;
  });
  if (!auth.scopes.includes(CHAT_SCOPE)) {
    throw new Error("Die Twitch-Anmeldung darf den Chat noch nicht lesen. Bitte einmal trennen und neu mit Twitch verbinden.");
  }
  const userId = auth.userId!;

  const lines: string[] = [];
  const log = (line: string) => {
    opts.log(line);
    lines.push(`${new Date().toISOString()} ${line}`);
    if (lines.length > LOG_LINES) lines.shift();
  };
  let connection: "connecting" | "connected" | "disconnected" = "connecting";
  let fatal: string | undefined;
  let last: LiveStatus["last"];

  const recorder = new LiveRecorder(userId, auth.login, {
    ...opts,
    log,
    async onFinished(result: AnalysisResult, finishedLog: (line: string) => void) {
      last = {
        id: result.report.video.id ?? result.dir,
        title: result.report.video.title,
        highlights: result.highlights.length,
        at: new Date().toISOString(),
      };
      await opts.onFinished?.(result, finishedLog);
    },
  });
  const sync = () => recorder.sync().catch((err) => log(`Abgleich fehlgeschlagen: ${err.message}`));

  const socket = connectEventSub(
    {
      async onSession(sessionId) {
        const broadcaster = { broadcaster_user_id: userId };
        // Nacheinander, damit ein nötiges Token-Refresh nur einmal passiert
        await subscribeEventSub("stream.online", broadcaster, sessionId, opts.authPath);
        await subscribeEventSub("stream.offline", broadcaster, sessionId, opts.authPath);
        await subscribeEventSub("channel.chat.message", { ...broadcaster, user_id: userId }, sessionId, opts.authPath);
        await subscribeEventSub("channel.chat.notification", { ...broadcaster, user_id: userId }, sessionId, opts.authPath);
        connection = "connected";
        log(`Verbunden mit Twitch, warte auf Streams von ${auth.login ?? userId}.`);
        await sync();
      },
      onEvent(type, event, timestamp) {
        recorder.handle(type, event, timestamp).catch((err) => log(`Fehler bei ${type}: ${err.message}`));
      },
      onDisconnect(reason) {
        connection = "disconnected";
        log(`Verbindung zu Twitch getrennt: ${reason}. Verbinde neu …`);
        recorder.disconnected();
      },
      onRevocation(type, status) {
        log(`Twitch hat das Abo ${type} beendet (${status}).`);
        if (status === "authorization_revoked" || status === "user_removed") {
          fatal = "Die Twitch-Anmeldung wurde widerrufen. Bitte neu verbinden.";
          log(fatal);
          void service.stop().then(() => opts.onFatal?.(fatal!));
        }
      },
    },
    EVENTSUB_WS_URL,
    opts.createSocket,
  );

  const timers = [
    setInterval(sync, SYNC_INTERVAL_MS),
    setInterval(() => checkAuth(opts.authPath).catch((err) => log(`Twitch-Anmeldung: ${err.message}`)), VALIDATE_INTERVAL_MS),
  ];

  let stopped: Promise<void> | undefined;
  const service: LiveService = {
    status() {
      const rec = recorder.status();
      const state = fatal ? "error" : connection === "connected" || rec.state !== "waiting" ? rec.state : connection;
      return {
        state,
        message: fatal,
        connected: connection === "connected" && !fatal,
        channel: auth.login,
        stream: rec.stream,
        analyzeAt: rec.analyzeAt,
        last,
        log: [...lines],
      };
    },
    log,
    stop() {
      stopped ??= (async () => {
        timers.forEach(clearInterval);
        socket.close();
        await recorder.stop();
      })();
      return stopped;
    },
  };
  return service;
}
