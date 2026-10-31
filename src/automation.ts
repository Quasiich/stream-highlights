import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { CLIP_QUALITIES, type ClipSettings, clipFolder, cutClips, defaultClipSettings, fitClip } from "./clips.ts";
import {
  clipsMessage,
  clipUploadMessage,
  DEFAULT_MESSAGE,
  defaultDiscordSettings,
  OLD_DEFAULT_MESSAGE,
  type DiscordSettings,
  type DiscordWebhook,
  highlightsMessage,
  isWebhookUrl,
  postToAll,
  postToDiscord,
  TooLargeError,
  UPLOAD_LIMITS_MB,
  WEBHOOK_PURPOSES,
  webhookLabel,
  webhooksFor,
} from "./discord.ts";
import { type ClipFile, OUTPUT_DIR, type PostedRanks, type Progress, type Report, writeReport } from "./pipeline.ts";
import { loadSettings, SETTINGS_FILE, type Settings } from "./settings.ts";
import { ensureFfmpeg, ensureTwitchDownloader } from "./tools.ts";

/**
 * "auto": nach der Live-Auswertung gleich posten (die besten n).
 * "manual": erst, wenn der Streamer im Ergebnis ausgewählt hat.
 */
export type PublishMode = "auto" | "manual";

/** Was nach einer Auswertung passiert: Discord-Post und Clips */
export interface AutomationSettings {
  mode: PublishMode;
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
    .map((w) => ({
      name: typeof w?.name === "string" ? w.name.trim().slice(0, 50) : "",
      url: typeof w?.url === "string" ? w.url.trim() : "",
      purpose: WEBHOOK_PURPOSES.includes(w?.purpose) ? w.purpose : "all",
    }))
    .filter((w) => w.url);
}

/** Prüft und vervollständigt Einstellungen aus settings.json bzw. der Oberfläche */
export function normalizeAutomation(raw: Pick<Settings, "discord" | "clips" | "publish"> = {}): AutomationSettings {
  const d: any = raw.discord ?? {};
  const c: any = raw.clips ?? {};
  const webhooks = webhookList(d)
    .filter((w) => isWebhookUrl(w.url))
    .slice(0, MAX_WEBHOOKS);
  const custom = typeof d.message === "string" && d.message.trim() && d.message.trim() !== OLD_DEFAULT_MESSAGE;
  const message = custom ? d.message.trim().slice(0, MAX_MESSAGE) : DEFAULT_MESSAGE;
  const lengthSeconds = range(c.lengthSeconds, defaultClipSettings.lengthSeconds, 5, 600);
  return {
    mode: raw.publish?.mode === "manual" ? "manual" : "auto",
    discord: {
      enabled: Boolean(d.enabled) && webhooksFor(webhooks, "highlights").length > 0,
      webhooks,
      top: range(d.top, defaultDiscordSettings.top, 1, 25),
      message,
      uploadClips: Boolean(d.uploadClips) && webhooksFor(webhooks, "clips").length > 0,
      uploadLimitMb: UPLOAD_LIMITS_MB.includes(Number(d.uploadLimitMb)) ? Number(d.uploadLimitMb) : 0,
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
export async function sendHighlights(report: Report, s: DiscordSettings, ranks?: number[]): Promise<string[]> {
  const webhooks = webhooksFor(s.webhooks, "highlights");
  if (!webhooks.length) throw new Error("Bitte zuerst in den Einstellungen einen Discord-Webhook für Highlights eintragen.");
  return sendToAll(webhooks, highlightsMessage(report, s.top, s.message, ranks));
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

const BOOST_HINT: Record<number, string> = { 10: "Server ohne Boost", 50: "Boost-Stufe 2", 100: "Boost-Stufe 3" };

/** Erklärt, warum die Qualität verringert wurde und wo man die Grenze selbst einstellt */
export function shrinkNote(name: string, count: number, limitMb: number, auto: boolean): string {
  const clips = count === 1 ? "Bei 1 Clip wurde" : `Bei ${count} Clips wurde`;
  return auto
    ? `${name}: Discord hat die volle Qualität abgelehnt, der Server erlaubt offenbar nur ${limitMb} MB pro Datei (${BOOST_HINT[limitMb]}). ` +
        `${clips} deshalb die Qualität verringert. Fest einstellen lässt sich das unter Einstellungen → Clips in Discord → Upload-Grenze.`
    : `${name}: ${clips} die Qualität verringert, weil in den Einstellungen eine Upload-Grenze von ${limitMb} MB (${BOOST_HINT[limitMb]}) gewählt ist. ` +
        `Ist der Server stärker geboostet, dort unter Clips in Discord → Upload-Grenze eine höhere Grenze oder „Automatisch“ wählen.`;
}

/** Pro Webhook die Upload-Grenze, die im Automatik-Modus geklappt hat (bis zum Neustart) */
const learnedLimits = new Map<string, number>();

/**
 * Lädt die Clips als Videos an alle Clip-Webhooks hoch, ein Clip pro
 * Nachricht. Mit fester Grenze werden größere Clips vorher verkleinert. Im
 * Automatik-Modus geht erst die volle Größe raus; lehnt Discord ab, wird es
 * mit der nächstkleineren Grenze (50, dann 10 MB) versucht. Wirft, wenn es
 * bei mindestens einem Webhook nicht ganz geklappt hat.
 */
export async function sendClips(
  report: Report,
  clips: ClipFile[],
  s: DiscordSettings,
  onProgress: (p: Progress) => void = () => {},
  log: (line: string) => void = () => {},
  /** Für Tests austauschbar */
  deps: { post?: typeof postToDiscord; fit?: typeof fitClip; ffmpeg?: () => Promise<string> } = {},
): Promise<string[]> {
  const { post = postToDiscord, fit = fitClip } = deps;
  const webhooks = webhooksFor(s.webhooks, "clips");
  if (!webhooks.length) throw new Error("Bitte zuerst in den Einstellungen einen Discord-Webhook für Clips eintragen.");
  if (!clips.length) throw new Error("Es gibt noch keine geschnittenen Clips.");
  const sorted = [...clips].sort((a, b) => a.rank - b.rank);

  // ffmpeg erst holen, wenn wirklich verkleinert werden muss
  let ffmpeg: Promise<string> | undefined;
  const getFfmpeg = () =>
    (ffmpeg ??= deps.ffmpeg?.() ?? ensureTwitchDownloader((message, percent) => onProgress({ stage: "tools", message, percent })).then((d) =>
      ensureFfmpeg(d, (message, percent) => onProgress({ stage: "tools", message, percent })),
    ));
  const fitted = new Map<string, Promise<string>>();
  const fileFor = async (clip: ClipFile, limitMb: number) => {
    if ((await stat(clip.file)).size <= limitMb * 1e6) return clip.file;
    const key = `${clip.file}|${limitMb}`;
    if (!fitted.has(key)) fitted.set(key, getFfmpeg().then((f) => fit(f, clip, limitMb)));
    return fitted.get(key)!;
  };

  const sent: string[] = [];
  const errors: string[] = [];
  const steps = webhooks.length * sorted.length;
  for (const [w, hook] of webhooks.entries()) {
    const name = webhookLabel(hook, s.webhooks.indexOf(hook));
    let failed = 0;
    let shrunk = 0;
    let shrunkLimit = 0;
    for (const [i, clip] of sorted.entries()) {
      const step = w * sorted.length + i;
      onProgress({ stage: "discord", message: `Clip ${i + 1}/${sorted.length} an ${name} …`, percent: Math.round((step / steps) * 100) });
      const known = s.uploadLimitMb || learnedLimits.get(hook.url);
      const limits = UPLOAD_LIMITS_MB.filter((l) => !known || l <= known);
      const tried = new Set<string>();
      let error = "";
      for (const limit of limits) {
        let file: string;
        try {
          file = await fileFor(clip, limit);
        } catch (err: any) {
          error = err.message;
          break;
        }
        if (tried.has(file)) continue;
        tried.add(file);
        try {
          const data = await readFile(file);
          await post(hook.url, clipUploadMessage(report, clip, i, sorted.length, file !== clip.file), fetch, [{ name: basename(file), data }]);
          if (!s.uploadLimitMb && tried.size > 1) learnedLimits.set(hook.url, limit);
          if (file !== clip.file) {
            shrunk++;
            shrunkLimit = limit;
          }
          error = "";
          break;
        } catch (err: any) {
          error = !(err instanceof TooLargeError)
            ? err.message
            : s.uploadLimitMb
              ? `Clip #${clip.rank} ist zu groß für diesen Server, bitte in den Einstellungen eine kleinere Upload-Grenze wählen.`
              : `Clip #${clip.rank} ist auch mit 10 MB zu groß.`;
          if (!(err instanceof TooLargeError) || s.uploadLimitMb) break;
        }
      }
      if (error) {
        failed++;
        errors.push(`${name}: ${error}`);
        log(`${name}: ${error}`);
      }
    }
    if (failed < sorted.length) sent.push(name);
    if (shrunk) log(shrinkNote(name, shrunk, shrunkLimit, !s.uploadLimitMb));
  }
  onProgress({ stage: "discord", message: `Clips an ${sent.join(", ") || "keinen Webhook"} geschickt`, percent: 100 });
  if (errors.length) throw new Error(`${sent.length ? `Gesendet an ${sent.join(", ")}, aber: ` : ""}${errors.join(" ")}`);
  return sent;
}

/**
 * Schneidet die Clips (die besten s.count oder genau `ranks`) und merkt sie
 * sich in highlights.json. Früher geschnittene anderer Ränge bleiben dort stehen.
 */
export async function makeClips(
  report: Report,
  dir: string,
  s: ClipSettings,
  outDir = OUTPUT_DIR,
  onProgress: (p: Progress) => void = () => {},
  log: (line: string) => void = () => {},
  ranks?: number[],
): Promise<ClipFile[]> {
  const clips = await cutClips(report, s, outDir, onProgress, log, ranks);
  const kept = (report.clips ?? []).filter((c) => !clips.some((n) => n.rank === c.rank) && existsSync(c.file));
  report.clips = [...kept, ...clips].sort((a, b) => a.rank - b.rank);
  await writeReport(dir, report);
  return clips;
}

/** Soll überhaupt geschnitten werden? Der Upload braucht die Clips ja auch. */
export const wantsClips = (s: AutomationSettings) => s.clips.enabled || s.discord.uploadClips;

/** Welche Highlights wohin: undefined = diesen Teil auslassen */
export interface Selection {
  summary?: number[];
  clips?: number[];
}

/** Was beim Posten geklappt hat und was nicht, für Oberfläche und Protokoll */
export interface PublishResult {
  done: string[];
  errors: string[];
}

function markPosted(previous: PostedRanks | undefined, ranks: number[]): PostedRanks {
  return { at: new Date().toISOString(), ranks: [...new Set([...(previous?.ranks ?? []), ...ranks])].sort((a, b) => a - b) };
}

/**
 * Postet die Zusammenfassung und schneidet/lädt die Clips, jeweils für die
 * gewählten Highlights. Ein Fehler in einem Teil hält den anderen nicht auf.
 * Merkt sich in highlights.json, was gepostet wurde.
 */
export async function publish(
  report: Report,
  dir: string,
  sel: Selection,
  s: AutomationSettings,
  outDir = OUTPUT_DIR,
  onProgress: (p: Progress) => void = () => {},
  log: (line: string) => void = () => {},
  deps: { sendClips?: typeof sendClips } = {},
): Promise<PublishResult> {
  const result: PublishResult = { done: [], errors: [] };
  const done = (line: string) => (result.done.push(line), log(line));
  const fail = (line: string) => (result.errors.push(line), log(line));

  if (sel.summary) {
    try {
      const sent = await sendHighlights(report, s.discord, sel.summary);
      done(`Zusammenfassung mit ${sel.summary.length} ${sel.summary.length === 1 ? "Highlight" : "Highlights"} in Discord gepostet (${sent.join(", ")}).`);
      report.posted = { ...report.posted, summary: markPosted(report.posted?.summary, sel.summary) };
    } catch (err: any) {
      fail(`Discord: ${err.message}`);
    }
  }

  if (sel.clips?.length && !report.video.id) fail("Clips: Kein VOD zu diesem Stream, nichts zu schneiden.");
  else if (sel.clips?.length) {
    try {
      log(`Schneide ${sel.clips.length} Clips aus dem VOD …`);
      const clips = await makeClips(report, dir, s.clips, outDir, onProgress, (line) => log(`Clips: ${line}`), sel.clips);
      const folder = clipFolder(report, s.clips, outDir);
      done(`${clips.length} ${clips.length === 1 ? "Clip" : "Clips"} gespeichert in ${folder}`);
      if (s.discord.uploadClips && clips.length) {
        const notes: string[] = [];
        try {
          const sent = await (deps.sendClips ?? sendClips)(report, clips, s.discord, onProgress, (line) => notes.push(line));
          done(`Clips in Discord hochgeladen (${sent.join(", ")}).`);
          notes.forEach(done);
          report.posted = { ...report.posted, clips: markPosted(report.posted?.clips, clips.map((c) => c.rank)) };
        } catch (err: any) {
          fail(`Discord: ${err.message}`);
        }
      } else if (s.discord.enabled && clips.length) {
        // Ohne Upload nur der Hinweis, wo die Clips liegen
        await sendToAll(webhooksFor(s.discord.webhooks, "clips"), clipsMessage(report, clips, folder)).catch((err) => fail(`Discord: ${err.message}`));
      }
    } catch (err: any) {
      fail(`Clips: ${err.message}`);
    }
  }

  delete report.awaitingSelection;
  await writeReport(dir, report);
  return result;
}

/** Die besten n Ränge */
const topRanks = (report: Report, n: number) => [...report.highlights].sort((a, b) => a.rank - b.rank).slice(0, n).map((h) => h.rank);

/**
 * Läuft nach jeder automatischen (Live-)Auswertung. Im Modus „manuell“ wird
 * nur vermerkt, dass die Auswahl noch aussteht. Fehler werden nur
 * protokolliert: Die Analyse selbst ist da ja schon fertig.
 */
export async function runAutomation(
  { report, dir }: { report: Report; dir: string },
  s: AutomationSettings,
  log: (line: string) => void,
  outDir = OUTPUT_DIR,
  /** Fortschritt des Clip-Schnitts, für die Oberfläche */
  onProgress: (p: Progress) => void = () => {},
): Promise<void> {
  if (!s.discord.enabled && !wantsClips(s)) return;
  if (s.mode === "manual") {
    if (!report.highlights.length) return;
    report.awaitingSelection = true;
    await writeReport(dir, report);
    log(`${report.highlights.length} Highlights warten auf deine Auswahl: im Ergebnis ankreuzen und „Auswahl posten“.`);
    return;
  }
  await publish(
    report,
    dir,
    {
      summary: s.discord.enabled ? topRanks(report, s.discord.top) : undefined,
      clips: wantsClips(s) ? topRanks(report, s.clips.count) : undefined,
    },
    s,
    outDir,
    onProgress,
    log,
  );
}
