import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Highlight } from "./analyze.ts";
import { clock } from "./format.ts";
import type { ClipFile, Progress, Report } from "./pipeline.ts";
import { ensureFfmpeg, ensureTwitchDownloader, runTwitchDownloader } from "./tools.ts";

export interface ClipSettings {
  /** Nach jeder Live-Auswertung automatisch schneiden */
  enabled: boolean;
  /** "highlight": so lang wie das erkannte Highlight, "fixed": feste Länge um den Peak */
  mode: "highlight" | "fixed";
  /** So viele Highlights werden geschnitten, beginnend mit #1 */
  count: number;
  /** fixed: Länge jedes Clips */
  lengthSeconds: number;
  /** fixed: davon vor dem Peak (Marker bzw. stärkster Chat-Moment) */
  leadSeconds: number;
  /** highlight: zusätzlich vor dem Anfang und nach dem Ende */
  paddingSeconds: number;
  /** highlight: längere Highlights werden um den Peak herum gekürzt */
  maxLengthSeconds: number;
  /**
   * Auflösung wie "1080p" oder "720p" (TwitchDownloader nimmt die passende
   * Variante, z. B. 720p60), leer = beste verfügbare. Die beste ist bei
   * manchen Kanälen 1440p in HEVC, das spielen nicht alle Player ab.
   */
  quality: string;
  /** Leer: output/<VOD-ID>/clips, sonst <dir>/<Datum>_<VOD-ID> */
  dir: string;
}

export const defaultClipSettings: ClipSettings = {
  enabled: false,
  mode: "highlight",
  count: 5,
  lengthSeconds: 60,
  leadSeconds: 45,
  paddingSeconds: 5,
  maxLengthSeconds: 180,
  quality: "1080p",
  dir: "",
};

export const CLIP_QUALITIES = ["", "1080p", "720p", "480p", "360p"];

/** Anteil der Schritte von TwitchDownloaderCLI am Fortschritt eines Clips (von, bis in %) */
const STEPS: [string, number, number][] = [
  ["Downloading", 0, 80],
  ["Verifying", 80, 90],
  ["Finalizing", 90, 100],
];

/** Kürzere Clips lässt Twitch nicht zu und ergeben keinen Sinn */
const MIN_CLIP_SECONDS = 5;
/** Beim Kürzen bleibt so viel der Länge vor dem Peak, der Chat reagiert ja verzögert */
const LEAD_SHARE = 0.75;

export interface ClipRange {
  rank: number;
  start: number;
  end: number;
}

/** Welche Abschnitte geschnitten werden, nach Rang sortiert */
export function clipRanges(highlights: Highlight[], s: ClipSettings, videoLength?: number): ClipRange[] {
  return [...highlights]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, s.count)
    .map((h) => {
      let start: number;
      let end: number;
      if (s.mode === "fixed") {
        start = h.peak - s.leadSeconds;
        end = start + s.lengthSeconds;
      } else {
        start = h.start - s.paddingSeconds;
        end = h.end + s.paddingSeconds;
        if (end - start > s.maxLengthSeconds) {
          start = Math.max(start, h.peak - Math.round(s.maxLengthSeconds * LEAD_SHARE));
          end = start + s.maxLengthSeconds;
        }
      }
      // Am Anfang des VODs die Länge behalten, statt den Clip zu verkürzen
      if (start < 0) {
        end -= start;
        start = 0;
      }
      start = Math.round(start);
      end = Math.round(videoLength ? Math.min(end, videoLength) : end);
      return { rank: h.rank, start, end };
    })
    .filter((r) => r.end - r.start >= MIN_CLIP_SECONDS);
}

/** 2026-10-30 in der Zeitzone dieses Rechners */
function localDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function clipFolder(report: Report, s: ClipSettings, outDir: string): string {
  const id = report.video.id!;
  return resolve(s.dir.trim() ? join(s.dir.trim(), `${localDate(report.analyzedAt)}_${id}`) : join(outDir, id, "clips"));
}

/** "01_26-15.mp4": Rang und Startzeit, damit die Dateien sortiert und auffindbar sind */
export function clipFileName(range: ClipRange): string {
  return `${String(range.rank).padStart(2, "0")}_${clock(range.start).replace(/:/g, "-")}.mp4`;
}

/**
 * Lädt die Highlight-Abschnitte des VODs als MP4. Schon vorhandene Clips
 * werden übersprungen, ein abgebrochener Lauf kann also einfach wiederholt
 * werden. Schlägt ein Clip fehl, geht es mit dem nächsten weiter.
 */
export async function cutClips(
  report: Report,
  s: ClipSettings,
  outDir: string,
  onProgress: (p: Progress) => void = () => {},
  log: (line: string) => void = () => {},
): Promise<ClipFile[]> {
  const id = report.video.id;
  if (!id) throw new Error("Zu diesem Stream gibt es kein VOD, aus dem geschnitten werden kann.");
  const ranges = clipRanges(report.highlights, s, report.video.length);
  if (!ranges.length) return [];

  const tool = (message: string, percent?: number) => onProgress({ stage: "tools", message, percent });
  const downloader = await ensureTwitchDownloader(tool);
  const ffmpeg = await ensureFfmpeg(downloader, tool);
  const folder = clipFolder(report, s, outDir);
  await mkdir(folder, { recursive: true });

  const done: ClipFile[] = [];
  const errors: string[] = [];
  for (const [i, range] of ranges.entries()) {
    const file = join(folder, clipFileName(range));
    const label = `Clip ${i + 1}/${ranges.length} (#${range.rank}, ${clock(range.start)} – ${clock(range.end)})`;
    if (existsSync(file)) {
      done.push({ ...range, file });
      continue;
    }
    onProgress({ stage: "clips", message: `${label} …`, percent: Math.round((i / ranges.length) * 100) });
    // Die Endung muss .mp4 bleiben, daran erkennt TwitchDownloader das Format
    const partial = file.replace(/\.mp4$/, ".part.mp4");
    const args = ["videodownload", "--id", id, "-b", `${range.start}s`, "-e", `${range.end}s`, "-o", partial];
    args.push("--ffmpeg-path", ffmpeg, "--collision", "Overwrite", "--banner", "false");
    if (s.quality) args.push("-q", s.quality);
    try {
      await runTwitchDownloader(downloader, args, `${label}:`, (step, percent) => {
        const [, from, to] = STEPS.find(([name]) => step.startsWith(name)) ?? ["", 0, 0];
        const share = (from + ((to - from) * percent) / 100) / 100;
        onProgress({ stage: "clips", message: `${label} …`, percent: Math.round(((i + share) / ranges.length) * 100) });
      });
      await rename(partial, file);
      done.push({ ...range, file });
    } catch (err: any) {
      await rm(partial, { force: true });
      errors.push(err.message);
      log(err.message);
    }
  }
  if (!done.length && errors.length) throw new Error(errors[0]);
  onProgress({ stage: "clips", message: `${done.length} von ${ranges.length} Clips fertig: ${folder}`, percent: 100 });
  return done;
}
