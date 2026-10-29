import type { ChatLog } from "./chat.ts";
import type { Highlight } from "./analyze.ts";
import { defaultEventMinimums, describe, type EventMinimums, isNotable, summarize, type StreamEvent } from "./events.ts";

/** So viele Raids/Gift-Bomben/Cheers stehen höchstens in der Konsole, der Rest in highlights.md */
const CONSOLE_EVENTS = 15;

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

function summaryLine(events: StreamEvent[]): string {
  const s = summarize(events);
  return `${s.subs} neue Subs, ${s.giftedSubs} verschenkte Subs, ${s.raids} Raids, ${s.bits} Bits`;
}

function minimumsNote(min: EventMinimums): string {
  return `Einzeln aufgeführt: Gift-Bomben ab ${min.giftedSubs} Subs, Raids ab ${min.raidViewers} Zuschauern, Cheers ab ${min.bits} Bits.`;
}

export function toConsole(
  log: ChatLog,
  highlights: Highlight[],
  events: StreamEvent[] = [],
  min: EventMinimums = defaultEventMinimums,
): string {
  const lines = [
    `${log.title ?? "VOD"}${log.channel ? ` (${log.channel})` : ""}`,
    `${log.messages.length} Chat-Nachrichten, ${clock(log.length ?? 0)} Länge`,
    "",
  ];
  if (highlights.length === 0) lines.push("Keine deutlichen Chat-Peaks gefunden.");
  for (const h of highlights) {
    const what =
      h.source === "chat"
        ? `Peak ${clock(h.peak)}, ${h.score}× normal, ${h.chatters} Chatter`
        : `★ Streamer-Marker ${clock(h.peak)}${h.source === "marker+chat" ? `, Chat ${h.score}× normal` : ""}`;
    lines.push(`#${h.rank}  ${clock(h.start)} – ${clock(h.end)}  (${what})`, `    ${vodLink(log.videoId, h.start)}`);
    if (h.markers.length) lines.push(`    Marker: ${h.markers.join(" / ")}`);
    if (h.topWords.length) lines.push(`    Chat: ${h.topWords.join(", ")}`);
    lines.push("");
  }

  if (events.length) {
    const notable = events.filter((e) => isNotable(e, min));
    lines.push("Subs, Raids & Bits (fließen nicht in die Highlights ein)", `    ${summaryLine(events)}`, `    ${minimumsNote(min)}`);
    for (const e of notable.slice(0, CONSOLE_EVENTS)) lines.push(`    ${clock(e.offset).padStart(7)}  ${e.user}: ${describe(e)}`);
    if (notable.length > CONSOLE_EVENTS) lines.push(`    … ${notable.length - CONSOLE_EVENTS} weitere in highlights.md`);
    lines.push("");
  }
  return lines.join("\n");
}

export function toMarkdown(
  log: ChatLog,
  highlights: Highlight[],
  events: StreamEvent[] = [],
  min: EventMinimums = defaultEventMinimums,
): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const rows = highlights.map(
    (h) =>
      `| ${h.rank} | ${cell(sourceLabel(h))} | [${clock(h.start)}](${vodLink(log.videoId, h.start)}) | ${clock(h.end - h.start)} | ${h.score}× | ${h.chatters} | ${cell(h.topWords.slice(0, 3).join(", "))} |`,
  );
  return [
    `# Highlights: ${log.title ?? log.videoId ?? "VOD"}`,
    "",
    "| # | Quelle | Start | Dauer | Ausschlag | Chatter | Chat sagt |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...eventsMarkdown(log, events, min),
  ].join("\n");
}

/** "★ Marker: Boss besiegt", "★ Marker + Chat", "Chat" */
function sourceLabel(h: Highlight): string {
  if (h.source === "chat") return "Chat";
  const label = h.source === "marker+chat" ? "★ Marker + Chat" : "★ Marker";
  return h.markers.length ? `${label}: ${h.markers.join(" / ")}` : label;
}

function eventsMarkdown(log: ChatLog, events: StreamEvent[], min: EventMinimums): string[] {
  if (events.length === 0) return [];
  const row = (e: StreamEvent) => `| [${clock(e.offset)}](${vodLink(log.videoId, e.offset)}) | ${e.user} | ${describe(e)} |`;
  const notable = events.filter((e) => isNotable(e, min));
  const lines = ["## Subs, Raids & Bits", "", `Fließen nicht in die Highlights ein. ${minimumsNote(min)}`, "", `**${summaryLine(events)}**`, ""];
  if (notable.length) {
    lines.push("| Zeit | Wer | Was |", "|---|---|---|", ...notable.map(row), "");
  }
  return lines;
}
