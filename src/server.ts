import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { type AnalyzeOptions, defaultOptions } from "./analyze.ts";
import {
  heldReports,
  loadAutomation,
  makeClips,
  normalizeAutomation,
  resumeHeld,
  RETRY_HELD_MS,
  retriesAutomatically,
  retryHeld,
  runAutomation,
  sendHighlights,
  webhookList,
} from "./automation.ts";
import { DEFAULT_MESSAGE, isWebhookUrl, MESSAGE_PLACEHOLDERS, postToDiscord, testMessage } from "./discord.ts";
import { estimateClipSeconds } from "./clips.ts";
import { type LiveService, startLive } from "./livemode.ts";
import { LiveProgress } from "./liveprogress.ts";
import { listReports, OUTPUT_DIR, parseVideoId, type Progress, readReport, runAnalysis } from "./pipeline.ts";
import { defaultRecorderOptions } from "./recorder.ts";
import { loadSettings, updateSettings } from "./settings.ts";
import { needsAnything, runSetup, type SetupNeeds, setupItems } from "./setup.ts";
import { findFfmpeg, findTwitchDownloader } from "./tools.ts";
import { AUTH_FILE, DEFAULT_CLIENT_ID, fetchVod, fetchVods, loadAuth, resolveClientId, startLogin } from "./twitch.ts";
import { defaultVoiceOptions, parseVoiceOptions, type VoiceOptions, WHISPER_MODELS, type WhisperModel } from "./voice.ts";
import { detectGpu, estimateVoice } from "./whisper.ts";
import { canSelfUpdate, checkForUpdate, deleteBackup, installUpdate, launchNewVersion, readBackup, VERSION } from "./update.ts";

export const PORT = 4777;

interface Job {
  id: string;
  input: string;
  /** Alle bisherigen SSE-Nachrichten, damit ein neu verbundener Browser alles sieht */
  messages: string[];
  listeners: Set<ServerResponse>;
  finished: boolean;
}

let job: Job | undefined;
/** Live-Mitschnitt in diesem Prozess, siehe setLive() */
const live: {
  enabled: boolean;
  options?: Record<string, unknown>;
  service?: LiveService;
  starting?: boolean;
  error?: string;
  retry?: ReturnType<typeof setTimeout>;
} = { enabled: false };
/** Neuer Versuch, wenn der Live-Mitschnitt nicht starten konnte (z. B. kein Internet beim Hochfahren) */
const LIVE_RETRY_MS = 60_000;
/** Fortschritt der automatischen Auswertung nach Stream-Ende */
const liveProgress = new LiveProgress();
/** Geschätzte Sekunden für den Clip-Schnitt nach der Auswertung, 0 wenn er aus ist */
let liveClipSeconds = 0;

let login: { state: "idle" | "pending" | "done" | "error"; userCode?: string; verificationUri?: string; error?: string } = {
  state: "idle",
};

/** Einrichtung vorab (Programme laden, Internetzugriff prüfen), siehe setup.ts */
let setup: {
  state: "idle" | "running" | "done" | "error";
  message?: string;
  percent?: number;
  error?: string;
  /** Der Fehler lag am blockierten Internetzugriff */
  network?: boolean;
  networkChecked?: boolean;
  at?: string;
} = { state: "idle" };

/** Selbst-Update der .exe, siehe POST /api/update */
let install: { state: "idle" | "downloading" | "restarting" | "error"; percent?: number; error?: string } = { state: "idle" };
/** Laufende HTTP-Server, damit sie vor dem Neustart den Port freigeben */
let servers: Server[] = [];

/**
 * Lokaler Server für die Web-Oberfläche. Lauscht nur auf dieser Maschine und
 * nimmt nur Anfragen an, die von der eigenen Seite kommen.
 */
export function startServer(html: () => Promise<string>, port = PORT): Promise<Server[]> {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // Schutz gegen DNS-Rebinding und Anfragen fremder Webseiten
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Unbekannter Host" });
    const origin = req.headers.origin;
    if (req.method !== "GET" && (!origin || !allowedHosts.has(origin.replace(/^http:\/\//, "")))) {
      return send(res, 403, { error: "Fremde Herkunft" });
    }

    try {
      await route(req, res, html);
    } catch (err: any) {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
  };

  // IPv4 und IPv6, da "localhost" je nach System auf ::1 auflöst
  const listen = (host: string) =>
    new Promise<Server>((resolveListen, reject) => {
      const server = createServer(handler);
      server.once("error", reject);
      server.listen(port, host, () => resolveListen(server));
    });
  return Promise.all([listen("127.0.0.1"), listen("::1").catch(() => undefined)]).then((list) => {
    servers = list.filter((s): s is Server => s !== undefined);
    // Wegen fehlendem Internetzugriff zurückgehaltene Discord-Posts und Clips nachholen
    setInterval(() => void retryHeldNow(), RETRY_HELD_MS).unref();
    return servers;
  });
}

async function route(req: IncomingMessage, res: ServerResponse, html: () => Promise<string>) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(await html());
  }

  if (req.method === "GET" && path === "/api/status") {
    const auth = await loadAuth();
    return send(res, 200, {
      version: VERSION,
      twitch: auth ? { login: auth.login ?? null } : null,
      // Nur eine eigene Client-ID zurückgeben, die gemeinsame App braucht keine Eingabe
      clientId: auth && auth.clientId !== DEFAULT_CLIENT_ID ? auth.clientId : null,
      downloader: Boolean(findTwitchDownloader()),
      running: job && !job.finished ? { id: job.id, input: job.input } : null,
      defaults: {
        top: defaultOptions.top,
        bucket: defaultOptions.bucketSeconds,
        gap: defaultOptions.minGapSeconds,
        markerLead: defaultOptions.markerLeadSeconds,
        minGifts: defaultOptions.eventMinimums.giftedSubs,
        minRaid: defaultOptions.eventMinimums.raidViewers,
        minBits: defaultOptions.eventMinimums.bits,
        voice: defaultVoiceOptions,
      },
      voice: {
        settings: (await loadSettings()).voice ?? defaultVoiceOptions,
        models: Object.entries(WHISPER_MODELS).map(([id, m]) => ({ id, label: m.label, sizeMb: m.sizeMb })),
        gpu: detectGpu(),
        // Fertige Whisper-Builds gibt es nur für Windows; sonst muss whisper-cli installiert sein
        platform: process.platform === "win32" ? "windows" : process.platform,
      },
    });
  }

  if (req.method === "GET" && path === "/api/voice/estimate") {
    const model = (url.searchParams.get("model") ?? "") in WHISPER_MODELS ? (url.searchParams.get("model") as WhisperModel) : defaultVoiceOptions.model;
    const id = parseVideoId(url.searchParams.get("id") ?? "");
    let length = Number(url.searchParams.get("length")) || undefined;
    if (!length && id) length = (await readReport(id))?.video.length;
    if (!length && id && existsSync(AUTH_FILE)) length = (await fetchVod(id).catch(() => undefined))?.length;
    if (!length) return send(res, 200, { length: null, perHour: await estimateVoice(3600, model) });
    return send(res, 200, { length, ...(await estimateVoice(length, model, id ? join(OUTPUT_DIR, id) : undefined)) });
  }

  // Die Oberfläche speichert jede Änderung, damit sie sofort auch für den Live-Mitschnitt gilt
  if (req.method === "POST" && path === "/api/voice") {
    const voice = parseVoiceOptions(await readJson(req));
    await updateSettings({ voice });
    return send(res, 200, voice);
  }

  if (req.method === "GET" && path === "/api/reports") return send(res, 200, await listReports());

  if (req.method === "GET" && path === "/api/vods") {
    if (!existsSync(AUTH_FILE)) return send(res, 401, { error: "Nicht mit Twitch verbunden." });
    const first = Math.min(20, num(url.searchParams.get("first"), 5));
    const page = await fetchVods(first, url.searchParams.get("after") || undefined);
    return send(res, 200, {
      vods: page.vods.map((v) => ({ ...v, analyzed: existsSync(join(OUTPUT_DIR, v.id, "highlights.json")) })),
      cursor: page.cursor ?? null,
    });
  }

  const reportMatch = path.match(/^\/api\/reports\/([\w-]+)$/);
  if (req.method === "GET" && reportMatch) {
    const report = await readReport(reportMatch[1]);
    return report ? send(res, 200, report) : send(res, 404, { error: "Analyse nicht gefunden" });
  }

  if (req.method === "POST" && path === "/api/analyze") {
    if (job && !job.finished) return send(res, 409, { error: "Es läuft schon eine Analyse." });
    const body = await readJson(req);
    const input = String(body.input ?? "").trim();
    if (!parseVideoId(input)) return send(res, 400, { error: "Bitte einen VOD-Link oder eine VOD-ID angeben, z. B. https://www.twitch.tv/videos/2912392719" });
    const opts = analyzeOptions(body);
    if (body.refresh) await rm(join(OUTPUT_DIR, parseVideoId(input)!, "chat.json"), { force: true });
    if (body.voice) await updateSettings({ voice: opts.voice });
    const id = startJob(input, async (progress) => ({ id: (await runAnalysis(input, opts, progress)).report.video.id }));
    return send(res, 202, { id });
  }

  if (path === "/api/automation" && req.method === "GET") {
    return send(res, 200, { ...(await loadAutomation()), placeholders: MESSAGE_PLACEHOLDERS, defaultMessage: DEFAULT_MESSAGE });
  }

  if (path === "/api/automation" && req.method === "POST") {
    const body = await readJson(req);
    const invalid = webhookList(body.discord).findIndex((w) => !isWebhookUrl(w.url));
    if (invalid >= 0) {
      const name = webhookList(body.discord)[invalid].name || `Webhook ${invalid + 1}`;
      return send(res, 400, { error: `${name}: Das ist keine gültige Discord-Webhook-URL (https://discord.com/api/webhooks/…).` });
    }
    const s = normalizeAutomation(body);
    if (body.discord?.enabled && !s.discord.enabled) return send(res, 400, { error: "Für den automatischen Post bitte mindestens einen Discord-Webhook eintragen." });
    await updateSettings({ discord: { ...s.discord }, clips: { ...s.clips } });
    return send(res, 200, s);
  }

  if (path === "/api/automation/test" && req.method === "POST") {
    const body = await readJson(req);
    await postToDiscord(String(body.url ?? ""), testMessage(typeof body.message === "string" ? body.message.trim() : undefined));
    return send(res, 200, { ok: true });
  }

  const discordMatch = path.match(/^\/api\/reports\/([\w-]+)\/discord$/);
  if (req.method === "POST" && discordMatch) {
    const report = await readReport(discordMatch[1]);
    if (!report) return send(res, 404, { error: "Analyse nicht gefunden" });
    const sent = await sendHighlights(report, (await loadAutomation()).discord);
    return send(res, 200, { sent });
  }

  const clipsMatch = path.match(/^\/api\/reports\/([\w-]+)\/clips$/);
  if (req.method === "POST" && clipsMatch) {
    if (job && !job.finished) return send(res, 409, { error: "Es läuft schon eine Analyse oder ein Clip-Schnitt." });
    const reportId = clipsMatch[1];
    const report = await readReport(reportId);
    if (!report) return send(res, 404, { error: "Analyse nicht gefunden" });
    const { clips } = await loadAutomation();
    const id = startJob(reportId, async (progress) => {
      const done = await makeClips(report, join(OUTPUT_DIR, reportId), clips, OUTPUT_DIR, progress);
      return { id: reportId, clips: done.length };
    });
    return send(res, 202, { id });
  }

  const clipsFolderMatch = path.match(/^\/api\/reports\/([\w-]+)\/clips\/open$/);
  if (req.method === "POST" && clipsFolderMatch) {
    // Nur Ordner öffnen, die das Programm selbst in highlights.json eingetragen hat
    const file = (await readReport(clipsFolderMatch[1]))?.clips?.[0]?.file;
    if (!file || !existsSync(dirname(file))) return send(res, 404, { error: "Clip-Ordner nicht gefunden" });
    openPath(dirname(file));
    return send(res, 200, { ok: true });
  }

  const jobMatch = path.match(/^\/api\/jobs\/(\w+)$/);
  if (req.method === "GET" && jobMatch) {
    if (!job || job.id !== jobMatch[1]) return send(res, 404, { error: "Analyse nicht gefunden" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    for (const m of job.messages) res.write(m);
    if (job.finished) return res.end();
    const current = job;
    current.listeners.add(res);
    req.on("close", () => current.listeners.delete(res));
    return;
  }

  if (path === "/api/setup" && req.method === "GET") return send(res, 200, await setupStatus());

  if (path === "/api/setup" && req.method === "POST") {
    const body = await readJson(req);
    // Die Oberfläche schickt die aktuellen Sprach-Einstellungen mit, gebraucht wird, was dort eingestellt ist
    if (body.voice) await updateSettings({ voice: parseVoiceOptions(body.voice) });
    startSetup("von Hand");
    return send(res, 202, await setupStatus());
  }

  const heldMatch = path.match(/^\/api\/reports\/([\w-]+)\/(retry|release)$/);
  if (req.method === "POST" && heldMatch) {
    if (job && !job.finished) return send(res, 409, { error: "Es läuft schon eine Analyse." });
    const [, id, action] = heldMatch;
    const jobId = startJob(id, async (progress) => {
      const log = (line: string) => progress({ stage: "analyze", message: line });
      const state = await resumeHeld(id, await loadAutomation(), await currentAnalyze(), log, {
        release: action === "release",
        onProgress: progress,
      });
      if (state === "held") throw new Error((await readReport(id))?.automation?.reason ?? "Es klappt noch nicht.");
      // Ein alter Einrichtungsfehler ist damit wohl erledigt: neu prüfen
      if (setup.state === "error") startSetup("nach erfolgreichem Versuch");
      return { id };
    });
    return send(res, 202, { id: jobId });
  }

  if (path === "/api/live" && req.method === "GET") return send(res, 200, liveStatus());

  if (path === "/api/live" && req.method === "POST") {
    const body = await readJson(req);
    if (body.enabled && !existsSync(AUTH_FILE)) return send(res, 400, { error: "Bitte zuerst mit Twitch verbinden." });
    if (body.options?.voice) await updateSettings({ voice: parseVoiceOptions(body.options.voice) });
    try {
      await setLive(Boolean(body.enabled), body.options && typeof body.options === "object" ? body.options : undefined);
    } catch (err: any) {
      return send(res, 400, { error: err.message });
    }
    // Jetzt, solange jemand am PC ist: Programme laden und Internetzugriff prüfen
    if (body.enabled) startSetup("Live-Mitschnitt eingeschaltet");
    return send(res, 200, liveStatus());
  }

  if (path === "/api/update" && req.method === "GET") {
    const info = await checkForUpdate(url.searchParams.has("force"));
    const { asset, ...rest } = info;
    return send(res, 200, {
      ...rest,
      installable: Boolean(asset),
      selfUpdate: canSelfUpdate(),
      blocked: updateBlocked(),
      install,
      backup: canSelfUpdate() ? ((await readBackup()) ?? null) : null,
    });
  }

  if (path === "/api/update/backup" && req.method === "DELETE") {
    if (!canSelfUpdate()) return send(res, 400, { error: "Nur in der stream-highlights.exe." });
    if (install.state === "downloading" || install.state === "restarting") return send(res, 409, { error: "Das Update läuft gerade." });
    await deleteBackup();
    return send(res, 200, { ok: true });
  }

  if (path === "/api/update" && req.method === "POST") {
    const blocked = updateBlocked();
    if (blocked) return send(res, 409, { error: blocked });
    const info = await checkForUpdate(true);
    if (!info.available) return send(res, 400, { error: `Du hast bereits die neueste Version (${info.current}).` });
    if (!info.asset) return send(res, 400, { error: "Für diese Version gibt es keine geprüfte .exe auf GitHub." });

    install = { state: "downloading", percent: 0 };
    installUpdate(info, (percent) => (install = { state: "downloading", percent }))
      .then(() => {
        install = { state: "restarting" };
        // Kurz warten, damit die Oberfläche "Neustart" noch abholen kann
        setTimeout(() => void restartIntoNewVersion(), 1000);
      })
      .catch((err) => (install = { state: "error", error: err.message }));
    return send(res, 202, install);
  }

  if (path === "/api/login" && req.method === "GET") return send(res, 200, login);

  if (path === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const pending = await startLogin(resolveClientId(String(body.clientId ?? "")));
    login = { state: "pending", userCode: pending.userCode, verificationUri: pending.verificationUri };
    pending.done.then(
      () => {
        login = { state: "done" };
        // Mit der neuen Anmeldung (z. B. jetzt mit Chat-Scope) neu starten
        if (live.enabled) void restartLive();
      },
      (err) => (login = { state: "error", error: err.message }),
    );
    openUrl(pending.verificationUri);
    return send(res, 200, login);
  }

  if (path === "/api/logout" && req.method === "POST") {
    await stopLive("Nicht mit Twitch verbunden.");
    await rm(AUTH_FILE, { force: true });
    login = { state: "idle" };
    return send(res, 200, { ok: true });
  }

  const folderMatch = path.match(/^\/api\/reports\/([\w-]+)\/open$/);
  if (req.method === "POST" && folderMatch) {
    const dir = resolve(OUTPUT_DIR, folderMatch[1]);
    if (!existsSync(dir)) return send(res, 404, { error: "Ordner nicht gefunden" });
    openPath(dir);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Nicht gefunden" });
}

/**
 * Startet eine Analyse oder einen Clip-Schnitt im Hintergrund. Der Browser
 * verfolgt den Fortschritt über /api/jobs/<id> (progress, done, failed).
 */
function startJob(input: string, run: (progress: (p: Progress) => void) => Promise<unknown>): string {
  const current: Job = { id: Date.now().toString(36), input, messages: [], listeners: new Set(), finished: false };
  job = current;
  const emit = (event: string, data: unknown) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    current.messages.push(message);
    for (const l of current.listeners) l.write(message);
  };
  run((p) => emit("progress", p))
    .then((result) => emit("done", result))
    .catch((err) => emit("failed", { error: err.message }))
    .finally(() => {
      current.finished = true;
      for (const l of current.listeners) l.end();
      current.listeners.clear();
    });
  return current.id;
}

// ---- Einrichtung und Nachholen ---------------------------------------------

/** Analyse-Einstellungen wie zuletzt in der Oberfläche, mit Sprache & Lautstärke */
async function currentAnalyze(): Promise<AnalyzeOptions> {
  const options = analyzeOptions(live.options ?? {});
  const voice = (await loadSettings()).voice;
  return voice ? { ...options, voice: parseVoiceOptions(voice) } : options;
}

/** Was die eingeschalteten Funktionen brauchen */
async function currentNeeds(): Promise<SetupNeeds> {
  const raw = (await loadSettings()).voice;
  const voice = raw ? parseVoiceOptions(raw) : undefined;
  return { voice: voice?.enabled ? voice.model : undefined, clips: (await loadAutomation()).clips.enabled };
}

/** Ins Protokoll des Live-Mitschnitts, sonst in die Konsole */
const note = (line: string) => (live.service ? live.service.log(line) : console.log(line));

async function setupStatus() {
  const needs = await currentNeeds();
  return {
    ...setup,
    needed: needsAnything(needs),
    items: await setupItems(needs),
    held: (await heldReports()).map(({ id, report }) => ({
      id,
      title: report.video.title,
      reason: report.automation?.reason,
      since: report.automation?.since,
      lastTry: report.automation?.lastTry,
      auto: retriesAutomatically(report),
    })),
  };
}

/** Lädt Fehlendes und prüft den Internetzugriff, im Hintergrund; läuft nie doppelt. */
function startSetup(trigger: string): void {
  if (setup.state === "running") return;
  setup = { state: "running", message: "Prüfe, was gebraucht wird …" };
  void (async () => {
    try {
      const needs = await currentNeeds();
      if (!needsAnything(needs)) {
        setup = { state: "idle" };
        return;
      }
      // Für den Verbindungstest: das neueste VOD des eigenen Kanals
      const videoId = existsSync(AUTH_FILE) ? (await fetchVods(1).catch(() => undefined))?.vods[0]?.id : undefined;
      const { networkChecked } = await runSetup(needs, (message, percent) => (setup = { state: "running", message, percent }), videoId);
      setup = { state: "done", networkChecked, at: new Date().toISOString() };
      note(`Einrichtung (${trigger}): alles bereit${networkChecked ? ", Internetzugriff geprüft" : ""}.`);
      // Vielleicht wurde der Zugriff gerade erst erlaubt
      void retryHeldNow();
    } catch (err: any) {
      setup = { state: "error", error: err.message, network: Boolean(err.network), at: new Date().toISOString() };
      note(`Einrichtung (${trigger}) fehlgeschlagen: ${err.message}`);
    }
  })();
}

/** Zurückgehaltenes nachholen, außer gerade läuft eine Analyse oder Live-Auswertung */
async function retryHeldNow(): Promise<void> {
  if ((job && !job.finished) || live.service?.status().state === "analyzing") return;
  await retryHeld(loadAutomation, currentAnalyze, note).catch((err) => note(`Nachholen fehlgeschlagen: ${err.message}`));
}

function analyzeOptions(body: any): AnalyzeOptions {
  return {
    ...defaultOptions,
    top: num(body.top, defaultOptions.top),
    bucketSeconds: num(body.bucket, defaultOptions.bucketSeconds),
    minGapSeconds: num(body.gap, defaultOptions.minGapSeconds),
    markerLeadSeconds: num(body.markerLead, defaultOptions.markerLeadSeconds),
    eventMinimums: {
      giftedSubs: num(body.minGifts, defaultOptions.eventMinimums.giftedSubs),
      raidViewers: num(body.minRaid, defaultOptions.eventMinimums.raidViewers),
      bits: num(body.minBits, defaultOptions.eventMinimums.bits),
    },
    voice: parseVoiceOptions(body.voice),
  };
}

// ---- Selbst-Update --------------------------------------------------------

/** Warum gerade nicht aktualisiert werden darf, sonst null */
function updateBlocked(): string | null {
  if (!canSelfUpdate()) return "Das Update per Knopf gibt es nur in der stream-highlights.exe. Im Quellcode: git pull und npm install.";
  const liveState = live.service?.status().state;
  if (liveState === "recording" || liveState === "ending" || liveState === "analyzing") {
    return "Update nicht möglich, solange ein Live-Mitschnitt läuft. Bitte warten, bis der Stream beendet und ausgewertet ist.";
  }
  if (job && !job.finished) return "Update nicht möglich, solange eine Analyse läuft.";
  if (install.state === "downloading" || install.state === "restarting") return "Das Update läuft bereits.";
  return null;
}

/** Gibt den Port frei, startet die neue .exe und beendet diese. */
async function restartIntoNewVersion(): Promise<void> {
  await shutdownLive();
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((done) => {
          s.close(() => done());
          s.closeAllConnections();
        }),
    ),
  );
  // Port und --no-minimize übernehmen; den Browser hat der Nutzer schon offen.
  const args: string[] = [];
  const portIndex = process.argv.indexOf("--port");
  if (portIndex > 0 && process.argv[portIndex + 1]) args.push("--port", process.argv[portIndex + 1]);
  if (process.argv.includes("--no-minimize")) args.push("--no-minimize");
  launchNewVersion(process.execPath, args);
  setTimeout(() => process.exit(0), 300);
}

// ---- Live-Mitschnitt ------------------------------------------------------

function liveStatus() {
  if (live.service) {
    const status = live.service.status();
    // Nach der Auswertung beginnt die nächste wieder bei null
    if (status.state !== "analyzing") {
      liveProgress.reset();
      liveClipSeconds = 0;
    }
    return { enabled: true, ...status, progress: liveProgress.get() };
  }
  const state = !live.enabled ? "off" : live.starting ? "connecting" : "error";
  return { enabled: live.enabled, state, message: live.error, connected: false, log: [] };
}

/**
 * Schaltet den Live-Mitschnitt ein oder aus und merkt sich das für den
 * nächsten Start. Wirft beim Einschalten, wenn er nicht starten kann.
 */
async function setLive(enabled: boolean, options?: Record<string, unknown>): Promise<void> {
  if (!enabled) {
    live.enabled = false;
    await stopLive();
    live.error = undefined;
  } else {
    live.enabled = true;
    live.options = options ?? live.options;
    try {
      await restartLive(true);
    } catch (err) {
      live.enabled = false;
      throw err;
    }
  }
  await updateSettings({ live: { enabled: live.enabled, options: live.options } });
}

async function stopLive(error?: string) {
  clearTimeout(live.retry);
  const service = live.service;
  live.service = undefined;
  live.error = error;
  await service?.stop();
}

/** (Neu) starten. Ohne `throwErrors` wird es nach einem Fehler später erneut versucht. */
async function restartLive(throwErrors = false): Promise<void> {
  await stopLive();
  live.starting = true;
  try {
    live.service = await startLive({
      ...defaultRecorderOptions(OUTPUT_DIR, analyzeOptions(live.options ?? {})),
      // Sprache & Lautstärke wie zuletzt in der Oberfläche eingestellt, nicht wie beim Einschalten
      currentAnalyze: async () => {
        // Der Clip-Schnitt kommt danach und zählt schon zur Gesamt-Restzeit
        const { clips } = await loadAutomation();
        liveClipSeconds = clips.enabled ? estimateClipSeconds(clips, !findFfmpeg()) : 0;
        return currentAnalyze();
      },
      // Fehlt noch etwas, wird es geladen, solange der Stream läuft
      onStreamStart: () => startSetup("Stream-Beginn"),
      onProgress: (p) => liveProgress.update("analyze", p, liveClipSeconds),
      onFatal: (message) => {
        live.service = undefined;
        live.error = message;
      },
      // Einstellungen erst jetzt lesen, damit Änderungen ohne Neustart gelten
      onFinished: async (result, log) => {
        try {
          await runAutomation(result, await loadAutomation(), log, OUTPUT_DIR, (p) => liveProgress.update("clips", p));
        } finally {
          liveProgress.reset();
          liveClipSeconds = 0;
        }
      },
    });
  } catch (err: any) {
    live.error = err.message;
    if (throwErrors) throw err;
    if (live.enabled && existsSync(AUTH_FILE)) live.retry = setTimeout(() => void restartLive(), LIVE_RETRY_MS);
  } finally {
    live.starting = false;
  }
}

/** Beim Programmstart: Live-Mitschnitt wieder einschalten, falls er zuletzt an war. */
export async function restoreLive(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.live?.enabled) return;
  live.enabled = true;
  live.options = settings.live.options;
  await restartLive();
  console.log(live.service ? "Live-Mitschnitt ist eingeschaltet." : `Live-Mitschnitt konnte nicht starten: ${live.error}`);
  startSetup("Programmstart");
  void retryHeldNow();
}

/** Beim Beenden den Mitschnitt sauber schließen, er wird beim nächsten Start fortgesetzt. */
export function shutdownLive(): Promise<void> {
  return stopLive();
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Anfrage zu groß");
  }
  return raw ? JSON.parse(raw) : {};
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return value !== "" && value !== undefined && value !== null && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Öffnet eine Webadresse im Standardbrowser. */
export function openUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  openPath(url);
}

function openPath(target: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer", [target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export async function readHtmlFromDisk(): Promise<string> {
  return readFile(resolve("ui/index.html"), "utf8");
}
