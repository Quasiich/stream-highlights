import type { Highlight } from "./analyze.ts";
import { clock, vodLink } from "./format.ts";
import type { ClipFile, Report } from "./pipeline.ts";

/** Wofür ein Webhook da ist: "all" bekommt Highlights und Clips */
export type WebhookPurpose = "all" | "highlights" | "clips";
export const WEBHOOK_PURPOSES: WebhookPurpose[] = ["all", "highlights", "clips"];

export interface DiscordWebhook {
  /** Nur zur Unterscheidung in Oberfläche und Fehlermeldungen, z. B. "Mods" */
  name: string;
  /** Siehe README. Geheim halten: Wer die URL kennt, kann in den Kanal schreiben. */
  url: string;
  /** Fehlt bei älteren settings.json, dann "all" */
  purpose?: WebhookPurpose;
}

export interface DiscordSettings {
  /** Nach jeder Live-Auswertung automatisch posten */
  enabled: boolean;
  /** Jeder Post geht an alle Webhooks (also in alle eingetragenen Kanäle) */
  webhooks: DiscordWebhook[];
  /** So viele Highlights stehen im Post */
  top: number;
  /** Text über den Highlights, mit Platzhaltern wie {kanal}, siehe MESSAGE_PLACEHOLDERS */
  message: string;
  /** Geschnittene Clips als Video an die Clip-Webhooks schicken */
  uploadClips: boolean;
  /**
   * Größte Datei pro Upload in MB: 10 ohne Boost, 50 ab Boost-Stufe 2, 100 ab
   * Stufe 3. 0 = automatisch: erst in voller Größe versuchen, bei „zu groß“
   * kleiner rechnen. Discord verrät über den Webhook nicht, wie der Server
   * geboostet ist.
   */
  uploadLimitMb: number;
}

/** Upload-Grenzen von Discord je Boost-Stufe, größte zuerst */
export const UPLOAD_LIMITS_MB = [100, 50, 10];

/** Webhooks, die eine Art von Post bekommen */
export function webhooksFor(webhooks: DiscordWebhook[], kind: "highlights" | "clips"): DiscordWebhook[] {
  return webhooks.filter((w) => (w.purpose ?? "all") === "all" || w.purpose === kind);
}

export const DEFAULT_MESSAGE = "Neue Highlights von **{kanal}**: die besten {anzahl} Highlights";
/** Standardtext bis 1.3.x; steht er unverändert in settings.json, gilt der neue */
/** Standardtext, wenn nur ein Highlight im Post steht („die besten 1 Highlights“ wäre schief) */
const DEFAULT_MESSAGE_ONE = "Neues Highlight von **{kanal}**";
export const OLD_DEFAULT_MESSAGE = "Neue Highlights von **{kanal}**: die besten {anzahl} von {gesamt}";

/** Platzhalter für den eigenen Text, mit Beschreibung für die Oberfläche */
export const MESSAGE_PLACEHOLDERS: Record<string, string> = {
  kanal: "Kanalname",
  titel: "Stream-Titel",
  anzahl: "Highlights im Post",
  gesamt: "Highlights insgesamt",
  datum: "Datum der Auswertung",
  link: "Link zum VOD",
};

/** Beispielwerte für Testnachricht und Vorschau */
const SAMPLE_VARS: Record<string, string> = {
  kanal: "scuse",
  titel: "Dienstagsmodus",
  anzahl: "5",
  gesamt: "10",
  datum: "30.10.2026",
  link: "https://www.twitch.tv/videos/2912392719",
};

export const defaultDiscordSettings: DiscordSettings = {
  enabled: false,
  webhooks: [],
  top: 5,
  message: DEFAULT_MESSAGE,
  uploadClips: false,
  uploadLimitMb: 0,
};

/** Discord erlaubt so viele Zeichen im Text einer Nachricht */
const MAX_CONTENT = 2000;

export interface DiscordPayload {
  username: string;
  content: string;
  embeds?: Record<string, unknown>[];
  allowed_mentions: { parse: string[] };
}

const WEBHOOK_URL = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
/** Grenzen von Discord für Embeds */
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
const ACCENT = 0x8a43f5;

export function isWebhookUrl(url: string): boolean {
  return WEBHOOK_URL.test(url.trim());
}

/** Chat-Wörter und Titel sollen nicht als Discord-Formatierung wirken */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>\[\]])/g, "\\$1");
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function highlightLine(h: Highlight, videoId: string | undefined): string {
  const time = videoId ? `[${clock(h.start)}](${vodLink(videoId, h.start)})` : clock(h.start);
  const what =
    h.source === "chat"
      ? `${h.score}× Chat, ${h.chatters} Chatter`
      : `★ Marker${h.markers.length ? `: ${escapeMarkdown(h.markers.join(" / "))}` : ""}${h.source === "marker+chat" ? `, Chat ${h.score}×` : ""}`;
  const words = h.topWords.length ? ` · „${escapeMarkdown(h.topWords.slice(0, 3).join(", "))}“` : "";
  return `**#${h.rank}** ${time} (${clock(h.end - h.start)}) · ${what}${words}`;
}

/** Setzt die Platzhalter ein; unbekannte wie {foo} bleiben stehen */
export function renderMessage(template: string, vars: Record<string, string>): string {
  return truncate(template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key.toLowerCase()] ?? match), MAX_CONTENT);
}

function messageVars(report: Report, count: number): Record<string, string> {
  const v = report.video;
  return {
    kanal: escapeMarkdown(v.channel || "Stream"),
    titel: escapeMarkdown(v.title || (v.id ? `VOD ${v.id}` : "Stream")),
    anzahl: String(count),
    gesamt: String(report.highlights.length),
    datum: new Date(report.analyzedAt).toLocaleDateString("de-DE"),
    link: v.id ? `https://www.twitch.tv/videos/${v.id}` : "",
  };
}

/** Post mit den besten Highlights einer Analyse, oder genau den ausgewählten (`ranks`) */
export function highlightsMessage(report: Report, top: number, template = DEFAULT_MESSAGE, ranks?: number[]): DiscordPayload {
  const v = report.video;
  const chosen = ranks ? report.highlights.filter((h) => ranks.includes(h.rank)) : report.highlights;
  const list = [...chosen].sort((a, b) => a.rank - b.rank).slice(0, ranks ? undefined : top);
  const lines = list.map((h) => highlightLine(h, v.id));
  let description = "";
  for (const line of lines) {
    if (description.length + line.length + 1 > MAX_DESCRIPTION) break;
    description += (description ? "\n" : "") + line;
  }

  const s = report.events?.summary;
  const fields =
    s && s.subs + s.giftedSubs + s.raids + s.bits > 0
      ? [{ name: "Subs, Raids & Bits", value: `${s.subs} neue Subs · ${s.giftedSubs} verschenkt · ${s.raids} Raids · ${s.bits} Bits` }]
      : [];
  const footer = [v.channel, v.length ? `${clock(v.length)} lang` : "", `${report.messageCount} Chat-Nachrichten`].filter(Boolean).join(" · ");

  return {
    username: "stream-highlights",
    content: list.length
      ? renderMessage(template === DEFAULT_MESSAGE && list.length === 1 ? DEFAULT_MESSAGE_ONE : template, messageVars(report, list.length))
      : `Stream${v.channel ? ` von **${escapeMarkdown(v.channel)}**` : ""} ausgewertet, keine deutlichen Highlights gefunden.`,
    embeds: [
      {
        title: truncate(v.title || (v.id ? `VOD ${v.id}` : "Stream"), MAX_TITLE),
        ...(v.id ? { url: `https://www.twitch.tv/videos/${v.id}` } : {}),
        ...(description ? { description } : {}),
        color: ACCENT,
        fields,
        footer: { text: footer },
        timestamp: report.analyzedAt,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/** Kurze Nachricht, sobald die Clips geschnitten sind */
export function clipsMessage(report: Report, clips: ClipFile[], folder: string): DiscordPayload {
  const v = report.video;
  const name = v.title ? `„${escapeMarkdown(truncate(v.title, 100))}“` : `VOD ${v.id}`;
  return {
    username: "stream-highlights",
    content: `🎬 ${clips.length} ${clips.length === 1 ? "Clip" : "Clips"} von ${name} geschnitten, liegen in \`${folder.replace(/`/g, "'")}\``,
    allowed_mentions: { parse: [] },
  };
}

/** Nachricht zu einem hochgeladenen Clip; der erste nennt den Stream */
export function clipUploadMessage(report: Report, clip: ClipFile, index: number, total: number, shrunk = false): DiscordPayload {
  const v = report.video;
  // <…> um den Link: sonst hängt Discord unter jedes Video eine Twitch-Vorschau des ganzen VODs
  const time = v.id ? `[${clock(clip.start)}](<${vodLink(v.id, clip.start)}>)` : clock(clip.start);
  const head = index === 0 ? `🎬 ${total} ${total === 1 ? "Clip" : "Clips"} von ${v.title ? `„${escapeMarkdown(truncate(v.title, 100))}“` : `VOD ${v.id}`}\n` : "";
  return {
    username: "stream-highlights",
    content: `${head}**#${clip.rank}** ${time} (${clock(clip.end - clip.start)})${shrunk ? " · Qualität für Discord verringert" : ""}`,
    allowed_mentions: { parse: [] },
  };
}

/** Testnachricht mit einer Vorschau des eigenen Textes (Beispielwerte) */
export function testMessage(template = DEFAULT_MESSAGE): DiscordPayload {
  return {
    username: "stream-highlights",
    content: truncate(
      "✅ Testnachricht von stream-highlights: Der Webhook funktioniert. So beginnt künftig der Post nach jedem Stream:\n\n" +
        renderMessage(template || DEFAULT_MESSAGE, SAMPLE_VARS),
      MAX_CONTENT,
    ),
    allowed_mentions: { parse: [] },
  };
}

export const webhookLabel = (w: DiscordWebhook, index: number) => w.name || `Webhook ${index + 1}`;

/** Datei als Anhang einer Nachricht */
export interface DiscordFile {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Discord lehnt die Datei als zu groß für diesen Server ab */
export class TooLargeError extends Error {}

/** Schickt an alle Webhooks; ein Fehler bei einem hält die anderen nicht auf. */
export async function postToAll(
  webhooks: DiscordWebhook[],
  payload: DiscordPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; error?: string }[]> {
  return Promise.all(
    webhooks.map(async (w, i) => {
      try {
        await postToDiscord(w.url, payload, fetchImpl);
        return { name: webhookLabel(w, i) };
      } catch (err: any) {
        return { name: webhookLabel(w, i), error: err.message as string };
      }
    }),
  );
}

/**
 * Schickt eine Nachricht an den Webhook. Bei Rate-Limit wird einmal nach der
 * von Discord genannten Zeit wiederholt. Die URL steht nie in Fehlermeldungen.
 */
export async function postToDiscord(
  webhookUrl: string,
  payload: DiscordPayload,
  fetchImpl: typeof fetch = fetch,
  files: DiscordFile[] = [],
): Promise<void> {
  if (!isWebhookUrl(webhookUrl)) throw new Error("Das ist keine gültige Discord-Webhook-URL (https://discord.com/api/webhooks/…).");
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(webhookUrl.trim(), { method: "POST", ...requestBody(payload, files) }).catch((err) => {
      throw new Error(`Discord ist nicht erreichbar (${err.message}).`);
    });
    if (res.ok) return;
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Number(body.retry_after) || 2) * 1000));
      continue;
    }
    if (res.status === 413 || body.code === 40005) throw new TooLargeError("Die Datei ist zu groß für diesen Discord-Server.");
    if (res.status === 401 || res.status === 404) throw new Error("Discord kennt diesen Webhook nicht (gelöscht oder falsch kopiert?).");
    throw new Error(`Discord hat abgelehnt (${res.status}${body.message ? `: ${body.message}` : ""}).`);
  }
}

/** JSON, oder mit Dateien multipart wie von Discord verlangt (payload_json + files[n]) */
function requestBody(payload: DiscordPayload, files: DiscordFile[]): RequestInit {
  if (!files.length) return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ ...payload, attachments: files.map((f, id) => ({ id, filename: f.name })) }));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data], { type: "video/mp4" }), f.name));
  return { body: form };
}
