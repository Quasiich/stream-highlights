import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

/** Lokale Anmeldedaten, siehe .gitignore. Nicht weitergeben. */
export const AUTH_FILE = ".twitch-auth.json";

/**
 * Client-ID der gemeinsamen Twitch-App von stream-highlights. Client-IDs sind
 * laut Twitch öffentlich, und die Anmeldung per Gerätecode braucht kein
 * Secret. So muss nicht jeder Streamer eine eigene App registrieren.
 */
export const DEFAULT_CLIENT_ID = "srajx2qq27l3oeu4trgh9hy9gl4g2j";

/** Eigene Client-ID (Eingabe oder TWITCH_CLIENT_ID), sonst die gemeinsame App. */
export function resolveClientId(custom?: string): string {
  return custom?.trim() || process.env.TWITCH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

/**
 * user:read:broadcast für die Stream-Marker, user:read:chat für den
 * Live-Mitschnitt des eigenen Chats (`npm run live`). Beides nur lesend.
 */
const SCOPES = "user:read:broadcast user:read:chat";
/** Ohne diesen Scope kann der Live-Mitschnitt den Chat nicht abonnieren. */
export const CHAT_SCOPE = "user:read:chat";
const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const MARKERS_URL = "https://api.twitch.tv/helix/streams/markers";
const VIDEOS_URL = "https://api.twitch.tv/helix/videos";
const STREAMS_URL = "https://api.twitch.tv/helix/streams";
const EVENTSUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

export interface TwitchAuth {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Kanal, mit dem angemeldet wurde */
  login?: string;
  userId?: string;
}

/** Ein vergangener Stream (VOD) des angemeldeten Kanals. */
export interface Vod {
  id: string;
  title: string;
  /** Beginn des Streams (ISO) */
  createdAt: string;
  /** Länge in Sekunden */
  length: number;
  views: number;
  /** Vorschaubild in 320×180, leer solange Twitch noch keins erzeugt hat */
  thumbnail: string;
  /** ID des Streams, aus dem das VOD stammt */
  streamId?: string;
}

/** Ein laufender Stream des eigenen Kanals. */
export interface LiveStream {
  id: string;
  /** Beginn (ISO) */
  startedAt: string;
  title: string;
}

/** Ein Stream-Marker, den der Streamer während des Streams gesetzt hat. */
export interface Marker {
  /** Sekunden seit Stream-Beginn */
  offset: number;
  description: string;
}

export async function loadAuth(path = AUTH_FILE): Promise<TwitchAuth | undefined> {
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, "utf8"));
}

export async function saveAuth(auth: TwitchAuth, path = AUTH_FILE): Promise<void> {
  await writeFile(path, JSON.stringify(auth, null, 2));
}

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(params) });
  const body: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PendingLogin {
  /** Code, den der Streamer auf verificationUri bestätigt */
  userCode: string;
  verificationUri: string;
  /** Erfüllt sich, sobald der Code bestätigt wurde (die Anmeldung ist dann schon gespeichert) */
  done: Promise<TwitchAuth>;
}

/**
 * Anmeldung per Gerätecode: Der Streamer bestätigt einen kurzen Code auf
 * twitch.tv/activate, das Programm wartet so lange. Braucht kein Client-Secret.
 */
export async function startLogin(clientId: string, authPath = AUTH_FILE): Promise<PendingLogin> {
  const start = await postForm(DEVICE_URL, { client_id: clientId, scopes: SCOPES });
  if (!start.ok) {
    throw new Error(`Twitch lehnt die Anmeldung ab (${start.status}: ${start.body.message ?? "unbekannt"}). Stimmt die Client-ID?`);
  }
  const { device_code, user_code, verification_uri } = start.body;
  const done = waitForLogin(clientId, device_code, Number(start.body.interval) || 5, Number(start.body.expires_in) || 1800).then(
    async (auth) => {
      await saveAuth(auth, authPath);
      return auth;
    },
  );
  return { userCode: user_code, verificationUri: verification_uri, done };
}

async function waitForLogin(clientId: string, device_code: string, interval: number, expiresIn: number): Promise<TwitchAuth> {
  const deadline = Date.now() + expiresIn * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await postForm(TOKEN_URL, {
      client_id: clientId,
      scopes: SCOPES,
      device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (res.ok) {
      const who = await validate(res.body.access_token);
      return { clientId, accessToken: res.body.access_token, refreshToken: res.body.refresh_token, login: who.login, userId: who.user_id };
    }
    if (res.body.message === "authorization_pending") continue;
    if (res.body.message === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(`Anmeldung fehlgeschlagen: ${res.body.message ?? res.status}`);
  }
  throw new Error("Der Code ist abgelaufen. Bitte erneut mit Twitch verbinden.");
}

interface Validation {
  login?: string;
  user_id?: string;
  scopes?: string[];
  /** Restlaufzeit des Access-Tokens in Sekunden */
  expires_in?: number;
}

async function validate(accessToken: string): Promise<Validation> {
  const res = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
  return res.ok ? ((await res.json()) as any) : {};
}

/** Laufende Erneuerungen je Refresh-Token, siehe refresh() */
const refreshing = new Map<string, Promise<TwitchAuth>>();

/**
 * Holt ein neues Access-Token (gilt 4 Stunden). Refresh-Tokens sind nur
 * einmal verwendbar: Wollen Oberfläche und Live-Mitschnitt gleichzeitig
 * erneuern, teilen sie sich eine Anfrage. Hat ein anderer Teil das Token
 * schon erneuert und gespeichert, wird die gespeicherte Anmeldung genommen.
 */
function refresh(auth: TwitchAuth, authPath: string): Promise<TwitchAuth> {
  let pending = refreshing.get(auth.refreshToken);
  if (!pending) {
    pending = requestRefresh(auth, authPath).finally(() => refreshing.delete(auth.refreshToken));
    refreshing.set(auth.refreshToken, pending);
  }
  return pending;
}

async function requestRefresh(auth: TwitchAuth, authPath: string): Promise<TwitchAuth> {
  const res = await postForm(TOKEN_URL, {
    client_id: auth.clientId,
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  });
  if (!res.ok) {
    const saved = await loadAuth(authPath).catch(() => undefined);
    if (saved && saved.refreshToken !== auth.refreshToken) return saved;
    throw new Error("Die Twitch-Anmeldung ist abgelaufen. Bitte erneut verbinden („Mit Twitch verbinden“ bzw. `npm run login`).");
  }
  return { ...auth, accessToken: res.body.access_token, refreshToken: res.body.refresh_token ?? auth.refreshToken };
}

/**
 * Lädt alle Stream-Marker eines VODs. Twitch gibt Marker nur für VODs des
 * angemeldeten Kanals heraus. Ein abgelaufenes Token wird automatisch erneuert
 * und gespeichert.
 */
export async function fetchMarkers(videoId: string, authPath = AUTH_FILE): Promise<Marker[]> {
  const markers: Marker[] = [];
  let after: string | undefined;
  do {
    const url = new URL(MARKERS_URL);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("first", "100");
    if (after) url.searchParams.set("after", after);

    const { res, auth } = await helix(url, authPath);
    if (!res.ok) {
      const body: any = await res.json().catch(() => ({}));
      throw new Error(
        `Twitch antwortet ${res.status} (${body.message ?? "unbekannt"}). Marker gibt es nur für VODs des angemeldeten Kanals` +
          `${auth.login ? ` (${auth.login})` : ""}.`,
      );
    }
    const body: any = await res.json();
    markers.push(...parseMarkers(body));
    after = body.pagination?.cursor || undefined;
  } while (after);

  return markers.sort((a, b) => a.offset - b.offset);
}

/**
 * Die vergangenen Streams des angemeldeten Kanals, neueste zuerst. `after`
 * ist der Cursor aus dem vorigen Aufruf, um ältere VODs nachzuladen; ist
 * `cursor` leer, gibt es keine weiteren.
 */
export async function fetchVods(first: number, after?: string, authPath = AUTH_FILE): Promise<{ vods: Vod[]; cursor?: string }> {
  let auth = await loadAuth(authPath);
  if (!auth) throw new Error("Nicht mit Twitch verbunden.");
  if (!auth.userId) {
    // Ältere Anmeldungen ohne gespeicherte Nutzer-ID nachträglich ergänzen
    auth = { ...auth, ...(await whoAmI(auth, authPath)) };
    await saveAuth(auth, authPath);
  }

  const url = new URL(VIDEOS_URL);
  url.searchParams.set("user_id", auth.userId!);
  url.searchParams.set("type", "archive");
  url.searchParams.set("first", String(Math.min(100, Math.max(1, first))));
  if (after) url.searchParams.set("after", after);

  const { res } = await helix(url, authPath);
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(`Twitch antwortet ${res.status} (${body.message ?? "unbekannt"}) beim Laden deiner VODs.`);
  }
  return parseVods(await res.json());
}

async function whoAmI(auth: TwitchAuth, authPath: string): Promise<Pick<TwitchAuth, "accessToken" | "refreshToken" | "login" | "userId">> {
  let who = await validate(auth.accessToken);
  if (!who.user_id) {
    auth = await refresh(auth, authPath);
    await saveAuth(auth, authPath);
    who = await validate(auth.accessToken);
  }
  if (!who.user_id) throw new Error("Twitch-Anmeldung ungültig. Bitte erneut verbinden.");
  return { accessToken: auth.accessToken, refreshToken: auth.refreshToken, login: who.login, userId: who.user_id };
}

/**
 * Prüft die gespeicherte Anmeldung und erneuert das Token, wenn es ungültig
 * ist oder in der nächsten Stunde abläuft. Twitch verlangt von dauerhaft
 * laufenden Programmen, das Token stündlich zu prüfen.
 */
export async function checkAuth(authPath = AUTH_FILE): Promise<TwitchAuth & { scopes: string[] }> {
  let auth = await loadAuth(authPath);
  if (!auth) throw new Error("Nicht mit Twitch verbunden. Bitte zuerst `npm run login` ausführen.");
  let who = await validate(auth.accessToken);
  if (!who.user_id || (who.expires_in ?? 0) < 3600) {
    auth = await refresh(auth, authPath);
    who = await validate(auth.accessToken);
    if (!who.user_id) throw new Error("Twitch-Anmeldung ungültig. Bitte erneut verbinden (`npm run login`).");
    auth = { ...auth, login: who.login, userId: who.user_id };
    await saveAuth(auth, authPath);
  }
  return { ...auth, login: who.login ?? auth.login, userId: who.user_id ?? auth.userId, scopes: who.scopes ?? [] };
}

/** Der laufende Stream des Kanals, undefined wenn offline. */
export async function fetchLiveStream(userId: string, authPath = AUTH_FILE): Promise<LiveStream | undefined> {
  const url = new URL(STREAMS_URL);
  url.searchParams.set("user_id", userId);
  url.searchParams.set("type", "live");
  const { res } = await helix(url, authPath);
  if (!res.ok) throw new Error(`Twitch antwortet ${res.status} beim Abfragen des Stream-Status.`);
  const s = ((await res.json()) as any).data?.[0];
  return s ? { id: String(s.id), startedAt: String(s.started_at), title: String(s.title ?? "") } : undefined;
}

/** Das VOD zu einem Stream unter den letzten Archiv-VODs des Kanals, falls Twitch eins gespeichert hat. */
export async function findVodForStream(streamId: string, authPath = AUTH_FILE): Promise<Vod | undefined> {
  const { vods } = await fetchVods(10, undefined, authPath);
  return vods.find((v) => v.streamId === streamId);
}

/**
 * Abonniert ein EventSub-Ereignis für eine WebSocket-Sitzung. Bei WebSockets
 * gehören die Abos zur Sitzung und enden mit ihr.
 */
export async function subscribeEventSub(
  type: string,
  condition: Record<string, string>,
  sessionId: string,
  authPath = AUTH_FILE,
): Promise<void> {
  const { res } = await helix(new URL(EVENTSUB_URL), authPath, {
    type,
    version: "1",
    condition,
    transport: { method: "websocket", session_id: sessionId },
  });
  if (!res.ok) {
    const body: any = await res.json().catch(() => ({}));
    throw new Error(`EventSub-Abo ${type} abgelehnt (${res.status}: ${body.message ?? "unbekannt"}).`);
  }
}

/**
 * Anfrage an die Twitch-API mit gespeicherter Anmeldung (GET, mit `body` POST). Ein abgelaufenes Token
 * wird einmal erneuert, gespeichert und die Anfrage wiederholt.
 */
async function helix(url: URL, authPath: string, body?: unknown): Promise<{ res: Response; auth: TwitchAuth }> {
  let auth = await loadAuth(authPath);
  if (!auth) throw new Error("Nicht angemeldet. Einrichtung siehe README, Abschnitt „Streamer-Marker“.");
  const headers = (a: TwitchAuth): Record<string, string> => ({
    "Client-Id": a.clientId,
    Authorization: `Bearer ${a.accessToken}`,
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
  });
  const get = (a: TwitchAuth) =>
    fetch(url, body === undefined ? { headers: headers(a) } : { method: "POST", headers: headers(a), body: JSON.stringify(body) });
  let res = await get(auth);
  if (res.status === 401) {
    auth = await refresh(auth, authPath);
    await saveAuth(auth, authPath);
    res = await get(auth);
  }
  return { res, auth };
}

/** Antwort von GET /helix/videos → VOD-Liste und Cursor für ältere */
export function parseVods(body: any): { vods: Vod[]; cursor?: string } {
  const vods = (body?.data ?? []).map((v: any) => ({
    id: String(v.id),
    title: String(v.title ?? ""),
    createdAt: String(v.created_at ?? ""),
    length: parseDuration(String(v.duration ?? "")),
    views: Number(v.view_count) || 0,
    // Platzhalter-URL von Twitch, solange das VOD noch verarbeitet wird
    thumbnail: String(v.thumbnail_url ?? "").includes("_404/")
      ? ""
      : String(v.thumbnail_url ?? "").replace("%{width}", "320").replace("%{height}", "180"),
    streamId: v.stream_id ? String(v.stream_id) : undefined,
  }));
  return { vods, cursor: body?.pagination?.cursor || undefined };
}

/** "3h2m1s" → 10921 */
export function parseDuration(text: string): number {
  const m = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** Antwort von GET /helix/streams/markers → Marker-Liste */
export function parseMarkers(body: any): Marker[] {
  const videos: any[] = (body?.data ?? []).flatMap((d: any) => d.videos ?? []);
  return videos
    .flatMap((v) => v.markers ?? [])
    .map((m: any) => ({ offset: Number(m.position_seconds) || 0, description: String(m.description ?? "").trim() }));
}
