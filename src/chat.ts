import { readFile } from "node:fs/promises";

/** Eine Chat-Nachricht, unabhängig vom Quellformat. */
export interface ChatMessage {
  /** Sekunden seit Stream-Beginn */
  offset: number;
  user: string;
  text: string;
  /** Namen der Twitch-/7TV-/BTTV-Emotes in der Nachricht */
  emotes: string[];
  /** z. B. "sub", "resub", "subgift", "raid", "bits" */
  event?: string;
}

export interface ChatLog {
  videoId?: string;
  title?: string;
  channel?: string;
  /** Länge des VODs in Sekunden, falls bekannt */
  length?: number;
  messages: ChatMessage[];
}

/**
 * Liest eine Chat-JSON von TwitchDownloaderCLI:
 *   TwitchDownloaderCLI chatdownload --id <VOD-ID> -o chat.json
 */
export async function loadChat(path: string): Promise<ChatLog> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return parseTwitchDownloader(raw);
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
      event: detectEvent(c),
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

function detectEvent(c: any): string | undefined {
  const notice = c.message?.user_notice_params?.["msg-id"];
  if (notice) return String(notice);
  if (Number(c.message?.bits_spent) > 0) return "bits";
  return undefined;
}
