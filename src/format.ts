import type { ChatLog } from "./chat.ts";
import type { Highlight } from "./analyze.ts";

/** 3725 -> "1:02:05" */
export function clock(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** 3725 -> "1h02m05s" (Twitch-Linkformat) */
export function twitchTime(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m${String(s % 60).padStart(2, "0")}s`;
}

export function vodLink(videoId: string | undefined, seconds: number): string {
  return videoId ? `https://www.twitch.tv/videos/${videoId}?t=${twitchTime(seconds)}` : clock(seconds);
}

export function toConsole(log: ChatLog, highlights: Highlight[]): string {
  const lines = [
    `${log.title ?? "VOD"}${log.channel ? ` (${log.channel})` : ""}`,
    `${log.messages.length} Chat-Nachrichten, ${clock(log.length ?? 0)} Länge`,
    "",
  ];
  if (highlights.length === 0) lines.push("Keine deutlichen Chat-Peaks gefunden.");
  for (const h of highlights) {
    lines.push(
      `#${h.rank}  ${clock(h.start)} – ${clock(h.end)}  (Peak ${clock(h.peak)}, ${h.score}× normal, ${h.chatters} Chatter)`,
      `    ${vodLink(log.videoId, h.start)}`,
    );
    if (h.topWords.length) lines.push(`    Chat: ${h.topWords.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function toMarkdown(log: ChatLog, highlights: Highlight[]): string {
  const rows = highlights.map(
    (h) =>
      `| ${h.rank} | [${clock(h.start)}](${vodLink(log.videoId, h.start)}) | ${clock(h.end - h.start)} | ${h.score}× | ${h.chatters} | ${h.topWords.slice(0, 3).join(", ").replace(/\|/g, "\\|")} |`,
  );
  return [
    `# Highlights: ${log.title ?? log.videoId ?? "VOD"}`,
    "",
    "| # | Start | Dauer | Ausschlag | Chatter | Chat sagt |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
