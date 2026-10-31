import { CLIP_QUALITIES, type ClipSettings, clipFolder, cutClips, defaultClipSettings } from "./clips.ts";
import {
  clipsMessage,
  DEFAULT_MESSAGE,
  defaultDiscordSettings,
  type DiscordSettings,
  type DiscordWebhook,
  highlightsMessage,
  isWebhookUrl,
  postToAll,
} from "./discord.ts";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzeOptions } from "./analyze.ts";
import { type AutomationState, type ClipFile, OUTPUT_DIR, type Progress, readReport, type Report, runAnalysis, writeReport } from "./pipeline.ts";
import { ensureFfmpeg, ensureTwitchDownloader, NetworkBlockedError } from "./tools.ts";
import { loadSettings, SETTINGS_FILE, type Settings } from "./settings.ts";

/** Was nach einer Auswertung passiert: Discord-Post und Clips */
export interface AutomationSettings {
  discord: DiscordSettings;
  clips: ClipSettings;
}

/** Zahl im Bereich, sonst der Standardwert */
function range(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return value !== "" && value !== null && value !== undefined && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

const MAX_WEBHOOKS = 10;
const MAX_MESSAGE = 1000;

/** Webhooks aus den Einstellungen; ältere settings.json hatten nur eine webhookUrl */
export function webhookList(d: any): DiscordWebhook[] {
  const raw: any[] = Array.isArray(d?.webhooks) ? d.webhooks : typeof d?.webhookUrl === "string" ? [{ url: d.webhookUrl }] : [];
  return raw
    .map((w) => ({ name: typeof w?.name === "string" ? w.name.trim().slice(0, 50) : "", url: typeof w?.url === "string" ? w.url.trim() : "" }))
    .filter((w) => w.url);
}

/** Prüft und vervollständigt Einstellungen aus settings.json bzw. der Oberfläche */
export function normalizeAutomation(raw: Pick<Settings, "discord" | "clips"> = {}): AutomationSettings {
  const d: any = raw.discord ?? {};
  const c: any = raw.clips ?? {};
  const webhooks = webhookList(d)
    .filter((w) => isWebhookUrl(w.url))
    .slice(0, MAX_WEBHOOKS);
  const message = typeof d.message === "string" && d.message.trim() ? d.message.trim().slice(0, MAX_MESSAGE) : DEFAULT_MESSAGE;
  const lengthSeconds = range(c.lengthSeconds, defaultClipSettings.lengthSeconds, 5, 600);
  return {
    discord: {
      enabled: Boolean(d.enabled) && webhooks.length > 0,
      webhooks,
      top: range(d.top, defaultDiscordSettings.top, 1, 25),
      message,
    },
    clips: {
      enabled: Boolean(c.enabled),
      mode: c.mode === "fixed" ? "fixed" : "highlight",
      count: range(c.count, defaultClipSettings.count, 1, 25),
      lengthSeconds,
      leadSeconds: range(c.leadSeconds, Math.min(defaultClipSettings.leadSeconds, lengthSeconds), 0, lengthSeconds),
      paddingSeconds: range(c.paddingSeconds, defaultClipSettings.paddingSeconds, 0, 120),
      maxLengthSeconds: range(c.maxLengthSeconds, defaultClipSettings.maxLengthSeconds, 10, 900),
      quality: CLIP_QUALITIES.includes(c.quality) ? c.quality : defaultClipSettings.quality,
      dir: typeof c.dir === "string" ? c.dir.trim() : "",
    },
  };
}

export async function loadAutomation(file = SETTINGS_FILE): Promise<AutomationSettings> {
  return normalizeAutomation(await loadSettings(file));
}

/**
 * Postet die Highlights an alle Webhooks, auch wenn der automatische Post aus
 * ist (für den Knopf in der Oberfläche). Gibt zurück, wohin gepostet wurde,
 * und wirft, wenn es bei mindestens einem Webhook nicht geklappt hat.
 */
export async function sendHighlights(report: Report, s: DiscordSettings): Promise<string[]> {
  return sendToAll(s.webhooks, highlightsMessage(report, s.top, s.message));
}

async function sendToAll(webhooks: DiscordWebhook[], payload: Parameters<typeof postToAll>[1]): Promise<string[]> {
  if (!webhooks.length) throw new Error("Bitte zuerst in den Einstellungen einen Discord-Webhook eintragen.");
  const results = await postToAll(webhooks, payload);
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    const sent = results.length - failed.length;
    throw new Error(
      `${sent ? `An ${sent} von ${results.length} Webhooks gesendet. ` : ""}${failed.map((r) => `${r.name}: ${r.error}`).join(" ")}`,
    );
  }
  return results.map((r) => r.name);
}

/** Schneidet die Clips und merkt sie sich in highlights.json */
export async function makeClips(
  report: Report,
  dir: string,
  s: ClipSettings,
  outDir = OUTPUT_DIR,
  onProgress: (p: Progress) => void = () => {},
  log: (line: string) => void = () => {},
): Promise<ClipFile[]> {
  const clips = await cutClips(report, s, outDir, onProgress, log);
  report.clips = clips;
  await writeReport(dir, report);
  return clips;
}

/** Wartet diese Auswertung darauf, dass Discord-Post und Clips nachgeholt werden? */
export function isHeld(report: Report): boolean {
  return report.automation?.state === "held";
}

/**
 * Warum Discord-Post und Clips noch warten sollten, sonst undefined: Die
 * Sprach-Auswertung ist fehlgeschlagen, oder für die Clips fehlen Programme,
 * die gerade nicht geladen werden können (z. B. Internetzugriff blockiert).
 */
async function holdReason(report: Report, s: AutomationSettings, log: (line: string) => void): Promise<string | undefined> {
  if (report.voiceFailed) return report.voiceNote ?? "Sprach-Auswertung fehlgeschlagen.";
  if (s.clips.enabled && report.video.id) {
    try {
      const downloader = await ensureTwitchDownloader();
      await ensureFfmpeg(downloader, (message) => log(`Clips: ${message}`));
    } catch (err: any) {
      if (err instanceof NetworkBlockedError) return `Programme für den Clip-Schnitt nicht verfügbar: ${err.message}`;
    }
  }
  return undefined;
}

/**
 * Läuft nach jeder automatischen (Live-)Auswertung. Ist die Auswertung
 * unvollständig, wird nichts gepostet oder geschnitten, sondern im Bericht als
 * "held" vermerkt; der Server holt es nach, sobald es klappt (siehe
 * retryHeld in server.ts). Mit `release` wird trotzdem gepostet. Andere Fehler
 * werden nur protokolliert: Die Analyse selbst ist da ja schon fertig.
 */
export async function runAutomation(
  { report, dir }: { report: Report; dir: string },
  s: AutomationSettings,
  log: (line: string) => void,
  outDir = OUTPUT_DIR,
  /** Fortschritt des Clip-Schnitts, für die Oberfläche */
  onProgress: (p: Progress) => void = () => {},
  { release = false }: { release?: boolean } = {},
): Promise<AutomationState["state"] | undefined> {
  if (!s.discord.enabled && !s.clips.enabled) return undefined;
  const now = new Date().toISOString();
  const reason = release ? undefined : await holdReason(report, s, log);
  if (reason) {
    report.automation = { state: "held", reason, since: report.automation?.since ?? now, lastTry: now };
    await writeReport(dir, report);
    log(`Discord-Post und Clips warten: ${reason} Sie werden nachgeholt, sobald es klappt, oder in der Oberfläche freigegeben.`);
    return "held";
  }

  if (s.discord.enabled) {
    try {
      const sent = await sendHighlights(report, s.discord);
      log(`Highlights in Discord gepostet (${sent.join(", ")}).`);
    } catch (err: any) {
      log(`Discord: ${err.message}`);
    }
  }
  const finish = async () => {
    report.automation = { state: release ? "released" : "done", at: new Date().toISOString() };
    await writeReport(dir, report);
    return report.automation.state;
  };
  if (!s.clips.enabled) return finish();
  if (!report.video.id) {
    log("Clips: Kein VOD zu diesem Stream, nichts zu schneiden.");
    return finish();
  }
  try {
    log(`Schneide ${Math.min(s.clips.count, report.highlights.length)} Clips aus dem VOD …`);
    const clips = await makeClips(report, dir, s.clips, outDir, onProgress, (line) => log(`Clips: ${line}`));
    const folder = clipFolder(report, s.clips, outDir);
    log(`${clips.length} Clips gespeichert in ${folder}`);
    if (s.discord.enabled && clips.length) {
      await sendToAll(s.discord.webhooks, clipsMessage(report, clips, folder)).catch((err) => log(`Discord: ${err.message}`));
    }
  } catch (err: any) {
    log(`Clips: ${err.message}`);
  }
  return finish();
}

/** Zurückgehaltene Auswertungen, älteste zuerst */
export async function heldReports(outDir = OUTPUT_DIR): Promise<{ id: string; report: Report }[]> {
  if (!existsSync(outDir)) return [];
  const list: { id: string; report: Report }[] = [];
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const report = await readReport(entry.name, outDir).catch(() => undefined);
    if (report && isHeld(report)) list.push({ id: entry.name, report });
  }
  return list.sort((a, b) => (a.report.automation?.since ?? "").localeCompare(b.report.automation?.since ?? ""));
}

/** Lag es nur am Internetzugriff? Dann lohnt ein automatischer neuer Versuch. */
export function retriesAutomatically(report: Report): boolean {
  return report.voiceFailed ? report.voiceFailed.network : /Internet|Firewall|Virenschutz/.test(report.automation?.reason ?? "");
}

/**
 * Holt eine zurückgehaltene Auswertung nach: Ist die Sprach-Auswertung
 * fehlgeschlagen, wird das VOD erneut ausgewertet (Chat und schon Fertiges
 * werden wiederverwendet), danach Discord und Clips. Klappt es wieder nicht,
 * bleibt sie zurückgehalten. `release` postet ohne neuen Versuch.
 */
export async function resumeHeld(
  id: string,
  s: AutomationSettings,
  analyze: AnalyzeOptions,
  log: (line: string) => void,
  { outDir = OUTPUT_DIR, release = false, onProgress = () => {} }: { outDir?: string; release?: boolean; onProgress?: (p: Progress) => void } = {},
): Promise<AutomationState["state"] | undefined> {
  const dir = join(outDir, id);
  let report = await readReport(id, outDir);
  if (!report) throw new Error("Analyse nicht gefunden");
  const held = report.automation;
  if (report.voiceFailed && !release) {
    log(`Werte ${report.video.title || id} erneut aus …`);
    report = (await runAnalysis(id, analyze, onProgress, outDir)).report;
    // Seit wann sie wartet, bleibt erhalten
    if (held) report.automation = held;
  }
  return runAutomation({ report, dir }, s, log, outDir, onProgress, { release });
}

/** Abstand der automatischen neuen Versuche */
export const RETRY_HELD_MS = 5 * 60_000;

let retrying = false;

/**
 * Versucht alle zurückgehaltenen Auswertungen erneut, bei denen es am
 * Internetzugriff lag. Für den Aufruf in festen Abständen; läuft nie doppelt.
 */
export async function retryHeld(
  loadSettings: () => Promise<AutomationSettings>,
  analyze: () => Promise<AnalyzeOptions>,
  log: (line: string) => void,
  outDir = OUTPUT_DIR,
): Promise<void> {
  if (retrying) return;
  retrying = true;
  try {
    for (const { id, report } of await heldReports(outDir)) {
      if (!retriesAutomatically(report)) continue;
      const state = await resumeHeld(id, await loadSettings(), await analyze(), log, { outDir }).catch((err) => {
        log(`Erneuter Versuch für ${id} fehlgeschlagen: ${err.message}`);
        return undefined;
      });
      if (state && state !== "held") log(`${report.video.title || id}: nachgeholt, Discord-Post und Clips sind erledigt.`);
    }
  } finally {
    retrying = false;
  }
}
