import { readFile } from "node:fs/promises";

/** Eine Chat-Nachricht, unabhängig vom Quellformat. */
export interface ChatMessage {
  /** Sekunden seit Stream-Beginn */
  offset: number;
  user: string;
  text: string;
  /** Namen der Twitch-/7TV-/BTTV-Emotes in der Nachricht */
  emotes: string[];
  /** z. B. "sub", "resub", "subgift", "submysterygift", "raid", "bits" */
  event?: string;
  /** Monate (resub), Anzahl Subs (submysterygift), Zuschauer (raid) oder Bits */
  amount?: number;
}

export interface ChatLog {
  videoId?: string;
  title?: string;
  channel?: string;
  /** Länge des VODs in Sekunden, falls bekannt */
  length?: number;
  messages: ChatMessage[];
}

/** Kennung der chat.json, die der Live-Mitschnitt (`npm run live`) schreibt */
export const LIVE_FORMAT = "stream-highlights-live";

/** Inhalt einer live mitgeschnittenen chat.json */
export interface LiveChatFile {
  format: typeof LIVE_FORMAT;
  video: { id?: string; title?: string; channel?: string; length?: number; streamId: string; startedAt: string };
  messages: ChatMessage[];
}

/**
 * Liest eine Chat-JSON von TwitchDownloaderCLI:
 *   TwitchDownloaderCLI chatdownload --id <VOD-ID> -o chat.json
 * oder eine live mitgeschnittene (siehe LiveChatFile).
 */
export async function loadChat(path: string): Promise<ChatLog> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return raw?.format === LIVE_FORMAT ? parseLiveChat(raw) : parseTwitchDownloader(raw);
}

export function parseLiveChat(raw: LiveChatFile): ChatLog {
  const { id, title, channel, length } = raw.video;
  return { videoId: id, title, channel, length, messages: [...raw.messages].sort((a, b) => a.offset - b.offset) };
}

export function parseTwitchDownloader(raw: any): ChatLog {
  if (!raw || !Array.isArray(raw.comments)) {
    throw new Error("Unbekanntes Format: erwartet wird eine Chat-JSON von TwitchDownloaderCLI (Feld 'comments' fehlt).");
  }

  const messages: ChatMessage[] = raw.comments.map((c: any) => {
    const fragments: any[] = c.message?.fragments ?? [];
    const emotes = fragments.filter((f) => f.emoticon).map((f) => String(f.text).trim());
    // Drittanbieter-Emotes (7TV/BTTV/FFZ) stehen nur als Text im Body.
    const text: string = c.message?.body ?? fragments.map((f) => f.text).join("");
    return {
      offset: Number(c.content_offset_seconds) || 0,
      user: c.commenter?.name ?? c.commenter?.display_name ?? "?",
      text,
      emotes,
      ...detectEvent(c, text),
    };
  });

  messages.sort((a, b) => a.offset - b.offset);

  const video = raw.video ?? {};
  const length = Number(video.length) || (video.end ? Number(video.end) - Number(video.start ?? 0) : undefined);

  return {
    videoId: video.id ? String(video.id) : undefined,
    title: video.title,
    channel: raw.streamer?.name,
    length: length || undefined,
    messages,
  };
}

// TwitchDownloader schreibt Sub-/Raid-Hinweise als normale Chatzeile des
// Auslösers, z. B. "Name subscribed at Tier 1. They've subscribed for 8 months, …".
const EVENT_PATTERNS: [event: string, pattern: RegExp][] = [
  ["submysterygift", /^ is gifting (\d+) Tier \d Subs? to /i],
  ["subgift", /^ gifted a Tier \d sub to /i],
  ["resub", /^ subscribed (?:with Prime|at Tier \d)\. They've subscribed for (\d+) months/i],
  ["sub", /^ subscribed (?:with Prime|at Tier \d)/i],
  ["raid", /^ is raiding with a party of (\d+)/i],
];

function detectEvent(c: any, text: string): Pick<ChatMessage, "event" | "amount"> {
  const notice = c.message?.user_notice_params?.["msg-id"];
  if (notice) return { event: String(notice) };
  const bits = Number(c.message?.bits_spent);
  if (bits > 0) return { event: "bits", amount: bits };

  const raiders = text.match(/^(\d+) raiders from \S+ have joined/i);
  if (raiders) return { event: "raid", amount: Number(raiders[1]) };

  // Nur wenn die Zeile mit dem eigenen Namen beginnt, damit normale
  // Nachrichten wie "subscribed at Tier 1 lol" nicht als Sub zählen.
  const name = [c.commenter?.display_name, c.commenter?.name].find(
    (n) => n && text.toLowerCase().startsWith(String(n).toLowerCase()),
  );
  if (!name) return {};
  const rest = text.slice(String(name).length);
  for (const [event, pattern] of EVENT_PATTERNS) {
    const m = rest.match(pattern);
    if (m) return { event, amount: m[1] ? Number(m[1]) : undefined };
  }
  return {};
}
