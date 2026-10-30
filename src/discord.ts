import type { Highlight } from "./analyze.ts";
import { clock, vodLink } from "./format.ts";
import type { ClipFile, Report } from "./pipeline.ts";

export interface DiscordSettings {
  /** Nach jeder Live-Auswertung automatisch posten */
  enabled: boolean;
  /** Webhook des Kanals, siehe README. Geheim halten: Wer ihn kennt, kann in den Kanal schreiben. */
  webhookUrl: string;
  /** So viele Highlights stehen im Post */
  top: number;
}

export const defaultDiscordSettings: DiscordSettings = { enabled: false, webhookUrl: "", top: 5 };

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

/** Post mit den besten Highlights einer Analyse */
export function highlightsMessage(report: Report, top: number): DiscordPayload {
  const v = report.video;
  const list = [...report.highlights].sort((a, b) => a.rank - b.rank).slice(0, top);
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
      ? `Neue Highlights${v.channel ? ` von **${escapeMarkdown(v.channel)}**` : ""}: die besten ${list.length} von ${report.highlights.length}`
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

export function testMessage(): DiscordPayload {
  return {
    username: "stream-highlights",
    content: "✅ Testnachricht von stream-highlights: Der Webhook funktioniert. Hier erscheinen künftig die Highlights nach jedem Stream.",
    allowed_mentions: { parse: [] },
  };
}

/**
 * Schickt eine Nachricht an den Webhook. Bei Rate-Limit wird einmal nach der
 * von Discord genannten Zeit wiederholt. Die URL steht nie in Fehlermeldungen.
 */
export async function postToDiscord(webhookUrl: string, payload: DiscordPayload, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!isWebhookUrl(webhookUrl)) throw new Error("Das ist keine gültige Discord-Webhook-URL (https://discord.com/api/webhooks/…).");
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(webhookUrl.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((err) => {
      throw new Error(`Discord ist nicht erreichbar (${err.message}).`);
    });
    if (res.ok) return;
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(10, Number(body.retry_after) || 2) * 1000));
      continue;
    }
    if (res.status === 401 || res.status === 404) throw new Error("Discord kennt diesen Webhook nicht (gelöscht oder falsch kopiert?).");
    throw new Error(`Discord hat abgelehnt (${res.status}${body.message ? `: ${body.message}` : ""}).`);
  }
}
