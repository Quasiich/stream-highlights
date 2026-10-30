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
import { type ClipFile, OUTPUT_DIR, type Progress, type Report, writeReport } from "./pipeline.ts";
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

/**
 * Läuft nach jeder automatischen (Live-)Auswertung. Fehler werden nur
 * protokolliert: Die Analyse selbst ist da ja schon fertig.
 */
export async function runAutomation(
  { report, dir }: { report: Report; dir: string },
  s: AutomationSettings,
  log: (line: string) => void,
  outDir = OUTPUT_DIR,
): Promise<void> {
  if (s.discord.enabled) {
    try {
      const sent = await sendHighlights(report, s.discord);
      log(`Highlights in Discord gepostet (${sent.join(", ")}).`);
    } catch (err: any) {
      log(`Discord: ${err.message}`);
    }
  }
  if (!s.clips.enabled) return;
  if (!report.video.id) {
    log("Clips: Kein VOD zu diesem Stream, nichts zu schneiden.");
    return;
  }
  try {
    log(`Schneide ${Math.min(s.clips.count, report.highlights.length)} Clips aus dem VOD …`);
    const clips = await makeClips(report, dir, s.clips, outDir, () => {}, (line) => log(`Clips: ${line}`));
    const folder = clipFolder(report, s.clips, outDir);
    log(`${clips.length} Clips gespeichert in ${folder}`);
    if (s.discord.enabled && clips.length) {
      await sendToAll(s.discord.webhooks, clipsMessage(report, clips, folder)).catch((err) => log(`Discord: ${err.message}`));
    }
  } catch (err: any) {
    log(`Clips: ${err.message}`);
  }
}
