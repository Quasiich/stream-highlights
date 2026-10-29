import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

/** Lokale Anmeldedaten, siehe .gitignore. Nicht weitergeben. */
export const AUTH_FILE = ".twitch-auth.json";

/** Reicht zum Lesen der Stream-Marker des eigenen Kanals. */
const SCOPES = "channel:read:broadcast";
const DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const MARKERS_URL = "https://api.twitch.tv/helix/streams/markers";

export interface TwitchAuth {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Kanal, mit dem angemeldet wurde */
  login?: string;
  userId?: string;
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

/**
 * Anmeldung per Gerätecode: Der Streamer bestätigt einen kurzen Code auf
 * twitch.tv/activate, das Programm wartet so lange. Braucht kein Client-Secret.
 */
export async function login(clientId: string, log: (line: string) => void = console.log): Promise<TwitchAuth> {
  const start = await postForm(DEVICE_URL, { client_id: clientId, scopes: SCOPES });
  if (!start.ok) {
    throw new Error(`Twitch lehnt die Anmeldung ab (${start.status}: ${start.body.message ?? "unbekannt"}). Stimmt die Client-ID?`);
  }
  const { device_code, user_code, verification_uri } = start.body;
  let interval = Number(start.body.interval) || 5;
  const deadline = Date.now() + (Number(start.body.expires_in) || 1800) * 1000;

  log(`Öffne ${verification_uri}`);
  log(`und bestätige dort mit deinem Streamer-Konto den Code: ${user_code}`);
  log("Warte auf Bestätigung …");

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
  throw new Error("Der Code ist abgelaufen. Bitte `npm run login` erneut starten.");
}

async function validate(accessToken: string): Promise<{ login?: string; user_id?: string }> {
  const res = await fetch(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
  return res.ok ? ((await res.json()) as any) : {};
}

/** Holt ein neues Access-Token (gilt 4 Stunden). Refresh-Tokens sind nur einmal verwendbar. */
async function refresh(auth: TwitchAuth): Promise<TwitchAuth> {
  const res = await postForm(TOKEN_URL, {
    client_id: auth.clientId,
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken,
  });
  if (!res.ok) throw new Error("Die Twitch-Anmeldung ist abgelaufen. Bitte `npm run login` erneut ausführen.");
  return { ...auth, accessToken: res.body.access_token, refreshToken: res.body.refresh_token ?? auth.refreshToken };
}

/**
 * Lädt alle Stream-Marker eines VODs. Twitch gibt Marker nur für VODs des
 * angemeldeten Kanals heraus. Ein abgelaufenes Token wird automatisch erneuert
 * und gespeichert.
 */
export async function fetchMarkers(videoId: string, authPath = AUTH_FILE): Promise<Marker[]> {
  let auth = await loadAuth(authPath);
  if (!auth) throw new Error("Nicht angemeldet. Einrichtung siehe README, Abschnitt „Streamer-Marker“.");

  const markers: Marker[] = [];
  let after: string | undefined;
  do {
    const url = new URL(MARKERS_URL);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("first", "100");
    if (after) url.searchParams.set("after", after);

    let res = await helix(url, auth);
    if (res.status === 401) {
      auth = await refresh(auth);
      await saveAuth(auth, authPath);
      res = await helix(url, auth);
    }
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

function helix(url: URL, auth: TwitchAuth) {
  return fetch(url, { headers: { "Client-Id": auth.clientId, Authorization: `Bearer ${auth.accessToken}` } });
}

/** Antwort von GET /helix/streams/markers → Marker-Liste */
export function parseMarkers(body: any): Marker[] {
  const videos: any[] = (body?.data ?? []).flatMap((d: any) => d.videos ?? []);
  return videos
    .flatMap((v) => v.markers ?? [])
    .map((m: any) => ({ offset: Number(m.position_seconds) || 0, description: String(m.description ?? "").trim() }));
}
