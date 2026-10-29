import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ChatLog, loadChat } from "./chat.ts";
import { type AnalyzeOptions, defaultOptions, findHighlights, type Highlight } from "./analyze.ts";
import { collectEvents, type EventSummary, isNotable, type StreamEvent, summarize } from "./events.ts";
import { toMarkdown } from "./format.ts";
import { ensureTwitchDownloader } from "./tools.ts";
import { AUTH_FILE, fetchMarkers, type Marker } from "./twitch.ts";

export const OUTPUT_DIR = "output";

export interface Progress {
  stage: "tools" | "chat" | "markers" | "analyze";
  message: string;
  /** 0–100, falls bekannt */
  percent?: number;
}

/** Inhalt von highlights.json */
export interface Report {
  video: { id?: string; title?: string; channel?: string; length?: number };
  /** Zeitpunkt der Analyse (ISO) */
  analyzedAt: string;
  messageCount: number;
  highlights: Highlight[];
  markers: Marker[];
  /** Warum keine Marker geladen wurden, falls zutreffend */
  markerNote?: string;
  events: { summary: EventSummary; list: StreamEvent[] };
}

export interface AnalysisResult {
  log: ChatLog;
  highlights: Highlight[];
  events: StreamEvent[];
  report: Report;
  dir: string;
}

/** "https://www.twitch.tv/videos/2912392719" oder "2912392719" → "2912392719" */
export function parseVideoId(input: string): string | undefined {
  return input.match(/(?:videos\/)?(\d{6,})/)?.[1];
}

/**
 * Der komplette Ablauf: Chat laden (oder vorhandenen wiederverwenden),
 * Streamer-Marker holen, auswerten und nach output/<id>/ schreiben.
 * `input` ist ein VOD-Link, eine VOD-ID oder eine chat.json.
 */
export async function runAnalysis(
  input: string,
  opts: AnalyzeOptions = defaultOptions,
  onProgress: (p: Progress) => void = () => {},
  outDir = OUTPUT_DIR,
): Promise<AnalysisResult> {
  const videoId = parseVideoId(input);
  let chatPath = input;
  if (!input.endsWith(".json")) {
    if (!videoId) throw new Error(`Keine VOD-ID erkannt in "${input}"`);
    chatPath = await downloadChat(videoId, join(outDir, videoId), onProgress);
  }

  const log = await loadChat(chatPath);
  log.videoId ??= videoId;

  const { markers, note } = log.videoId ? await loadMarkers(log.videoId, onProgress) : { markers: [], note: undefined };

  onProgress({ stage: "analyze", message: "Werte Chat aus …" });
  const highlights = findHighlights(log, opts, markers);
  const events = collectEvents(log);

  const report: Report = {
    video: { id: log.videoId, title: log.title, channel: log.channel, length: log.length },
    analyzedAt: new Date().toISOString(),
    messageCount: log.messages.length,
    highlights,
    markers,
    markerNote: note,
    events: { summary: summarize(events), list: events.filter(isNotable) },
  };

  const dir = join(outDir, log.videoId ?? "local");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "highlights.json"), JSON.stringify(report, null, 2));
  await writeFile(join(dir, "highlights.md"), toMarkdown(log, highlights, events));
  return { log, highlights, events, report, dir };
}

async function downloadChat(videoId: string, dir: string, onProgress: (p: Progress) => void): Promise<string> {
  const target = join(dir, "chat.json");
  if (existsSync(target)) {
    onProgress({ stage: "chat", message: `Chat bereits vorhanden: ${target}`, percent: 100 });
    return target;
  }

  const exe = await ensureTwitchDownloader((message, percent) => onProgress({ stage: "tools", message, percent }));
  await mkdir(dir, { recursive: true });
  onProgress({ stage: "chat", message: `Lade Chat von VOD ${videoId} …`, percent: 0 });

  // In eine Zwischendatei laden, damit ein abgebrochener Download nicht als
  // fertiger Chat gilt. Die Endung muss .json bleiben, daran erkennt
  // TwitchDownloader das Format.
  const partial = join(dir, "chat.part.json");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(exe, ["chatdownload", "--id", videoId, "-o", partial], { windowsHide: true });
    let output = "";
    const onData = (data: Buffer) => {
      const text = data.toString();
      output = (output + text).slice(-2000);
      // z. B. "[STATUS] - Downloading 42%" oder "[STATUS] - Backfilling Commenter Info 0%"
      for (const m of text.matchAll(/\[STATUS\] - ([^\[\r\n]*?)\s*(\d+)%/g)) {
        const step = m[1].startsWith("Downloading") ? "Lade Chat" : m[1];
        onProgress({ stage: "chat", message: `${step} …`, percent: Number(m[2]) });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => reject(new Error(`TwitchDownloaderCLI konnte nicht gestartet werden: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Chat-Download fehlgeschlagen (Code ${code}). ${output.trim().split(/\r?\n/).at(-1) ?? ""}`)),
    );
  }).catch(async (err) => {
    await rm(partial, { force: true });
    throw err;
  });
  await rename(partial, target);
  onProgress({ stage: "chat", message: "Chat geladen.", percent: 100 });
  return target;
}

/** Stream-Marker sind optional: ohne Anmeldung oder bei fremden VODs geht es nur mit dem Chat weiter. */
async function loadMarkers(videoId: string, onProgress: (p: Progress) => void): Promise<{ markers: Marker[]; note?: string }> {
  if (!existsSync(AUTH_FILE)) {
    return { markers: [], note: "Nicht mit Twitch verbunden, Streamer-Marker werden nicht berücksichtigt." };
  }
  onProgress({ stage: "markers", message: "Lade Streamer-Marker …" });
  try {
    const markers = await fetchMarkers(videoId);
    onProgress({ stage: "markers", message: `${markers.length} Streamer-Marker geladen.` });
    return { markers };
  } catch (err: any) {
    return { markers: [], note: `Streamer-Marker nicht geladen: ${err.message}` };
  }
}

/** Alle bisherigen Analysen im Ausgabeordner, neueste zuerst. */
export async function listReports(outDir = OUTPUT_DIR): Promise<(Report["video"] & { analyzedAt?: string; highlightCount: number })[]> {
  if (!existsSync(outDir)) return [];
  const list = [];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    const file = join(outDir, entry.name, "highlights.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    try {
      const report: Report = JSON.parse(await readFile(file, "utf8"));
      list.push({ ...report.video, id: report.video.id ?? entry.name, analyzedAt: report.analyzedAt, highlightCount: report.highlights.length });
    } catch {
      // Kaputte oder alte Datei überspringen
    }
  }
  return list.sort((a, b) => (b.analyzedAt ?? "").localeCompare(a.analyzedAt ?? ""));
}

export async function readReport(id: string, outDir = OUTPUT_DIR): Promise<Report | undefined> {
  if (!/^[\w-]+$/.test(id)) return undefined;
  const file = join(outDir, id, "highlights.json");
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : undefined;
}
