/**
 * Ton eines VODs holen, Lautstärke messen und mit Whisper (whisper.cpp)
 * transkribieren. Alle Programme und Modelle werden beim ersten Bedarf in den
 * Programmordner unter tools/ geladen, wie TwitchDownloaderCLI.
 *
 * Ergebnisse landen neben chat.json in output/<id>/:
 *   transcript.json  Whisper-Abschnitte mit Zeitstempeln (je Modell und Sprache)
 *   loudness.json    Pegel pro Sekunde in dBFS
 * Liegen beide vor, wird der Ton nicht erneut geladen. Die großen Ton-Dateien
 * werden danach gelöscht.
 */
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { ensureFfmpeg as ensureFfmpegTool, ensureTwitchDownloader, explainToolError, findFfmpeg, tarCommand } from "./tools.ts";
import {
  estimate,
  type Estimate,
  findKeywords,
  findLoudPeaks,
  remaining,
  type Segment,
  type VoiceOptions,
  type VoiceSignals,
  WHISPER_MODELS,
  type WhisperModel,
} from "./voice.ts";

const WIN = process.platform === "win32";
export const WHISPER_DIR = join("tools", "whisper");
const MODELS_DIR = join(WHISPER_DIR, "models");
const STATS_FILE = join(WHISPER_DIR, "stats.json");
// Nicht /latest: Die Versions-Releases (v1.9.5) kommen inzwischen ohne Dateien, die
// fertigen Builds stehen in eigenen Releases (b5454) daneben.
const RELEASES_URL = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15";
const MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const WHISPER_EXE = WIN ? "whisper-cli.exe" : "whisper-cli";

/** "cuda": Build für Nvidia-Grafikkarten, "cpu": läuft überall */
type Variant = "cuda" | "cpu";

export interface VoiceProgress {
  stage: "setup" | "audio" | "transcribe";
  message: string;
  percent?: number;
  /** Geschätzte Restzeit dieses Schritts in Sekunden */
  eta?: number;
  /** Geschätzte Restzeit der ganzen Sprach-Auswertung in Sekunden */
  totalEta?: number;
}

type OnProgress = (p: VoiceProgress) => void;

// ---- Erkennung ------------------------------------------------------------

let gpuCache: string | null | undefined;

/** Name der Nvidia-Grafikkarte, sonst null. */
export function detectGpu(): string | null {
  if (gpuCache !== undefined) return gpuCache;
  const res = spawnSync("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  gpuCache = res.status === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() || null : null;
  return gpuCache;
}

function which(name: string): string | undefined {
  const res = spawnSync(WIN ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  return res.status === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined;
}

/** Sucht eine Datei in einem Ordner und seinen Unterordnern (die Release-Zips haben einen Unterordner). */
function findFile(dir: string, name: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return resolve(path);
    if (entry.isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

function findWhisper(variant: Variant): string | undefined {
  if (process.env.WHISPER_CLI && existsSync(process.env.WHISPER_CLI)) return resolve(process.env.WHISPER_CLI);
  return findFile(join(WHISPER_DIR, variant), WHISPER_EXE) ?? (variant === "cpu" ? which("whisper-cli") : undefined);
}


const modelPath = (model: WhisperModel) => join(MODELS_DIR, WHISPER_MODELS[model].file);

// ---- Gemessene Geschwindigkeit -----------------------------------------------

interface Stats {
  /** Sekunden Ton pro Sekunde Rechenzeit, je "variante:modell" */
  speed: Record<string, number>;
  /** Der Grafikkarten-Build lief auf diesem PC nicht, seitdem wird der Prozessor benutzt */
  cudaBroken?: boolean;
}

async function loadStats(): Promise<Stats> {
  try {
    return { speed: {}, ...JSON.parse(await readFile(STATS_FILE, "utf8")) };
  } catch {
    return { speed: {} };
  }
}

async function saveStats(stats: Stats): Promise<void> {
  await mkdir(WHISPER_DIR, { recursive: true });
  await writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
}

async function preferredVariant(): Promise<Variant> {
  return detectGpu() && WIN && !(await loadStats()).cudaBroken ? "cuda" : "cpu";
}

/** Zeitschätzung für ein VOD dieser Länge, bevor die Auswertung startet. */
export async function estimateVoice(length: number, model: WhisperModel, dir?: string): Promise<Estimate & { gpuName: string | null }> {
  const variant = await preferredVariant();
  const stats = await loadStats();
  const transcript = dir ? await readTranscript(dir) : undefined;
  return {
    ...estimate({
      length,
      model,
      gpu: variant === "cuda",
      speed: stats.speed[`${variant}:${model}`],
      modelMissing: !existsSync(modelPath(model)),
      whisperMissing: !findWhisper(variant),
      ffmpegMissing: !findFfmpeg(),
      haveAudio: Boolean(dir && existsSync(join(dir, "audio.wav"))),
      haveTranscript: Boolean(transcript && transcript.model === model && dir && existsSync(join(dir, "loudness.json"))),
    }),
    gpuName: detectGpu(),
  };
}

// ---- Downloads ----------------------------------------------------------------

/** Lädt eine Datei in Teilstücken direkt auf die Platte (Modelle sind mehrere hundert MB groß). */
async function download(url: string, target: string, onProgress: (percent: number | undefined, eta: number | undefined) => void): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const partial = target + ".part";
  const started = Date.now();
  let loaded = 0;
  let lastPercent: number | undefined = -1;
  async function* counted(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      loaded += chunk.length;
      const percent = total ? Math.floor((loaded / total) * 100) : undefined;
      if (percent !== lastPercent) {
        lastPercent = percent;
        onProgress(percent, percent === undefined ? undefined : remaining(percent, (Date.now() - started) / 1000));
      }
      yield chunk;
    }
  }
  try {
    await pipeline(res.body as any as AsyncIterable<Uint8Array>, counted, createWriteStream(partial));
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, target);
}

async function ensureModel(model: WhisperModel, onProgress: OnProgress): Promise<string> {
  const path = modelPath(model);
  if (existsSync(path)) return resolve(path);
  await mkdir(MODELS_DIR, { recursive: true });
  const { label, file, sizeMb } = WHISPER_MODELS[model];
  await download(MODEL_URL + file, path, (percent, eta) =>
    onProgress({ stage: "setup", message: `Lade Whisper-Modell „${label}“ (${sizeMb} MB, einmalig) …`, percent, eta }),
  );
  return resolve(path);
}

/**
 * Neuestes Release mit passendem Windows-Download. Der CUDA-Build hieß bis
 * v1.9.4 "whisper-cublas-12.4.0-bin-x64.zip", seitdem
 * "whisper-bin-win-cuda-12.4.0-x64.zip".
 */
export function pickWhisperAsset(releases: any[], variant: Variant): { release: any; asset: any } | undefined {
  const pattern = variant === "cuda" ? /^whisper-(cublas-12[\d.]*-bin|bin-win-cuda-12[\d.]*)-x64\.zip$/i : /^whisper-bin-x64\.zip$/i;
  for (const release of releases) {
    if (release?.draft) continue;
    const asset = (release?.assets ?? []).find((a: any) => pattern.test(a.name));
    if (asset) return { release, asset };
  }
  return undefined;
}

/**
 * whisper.cpp aus dem offiziellen GitHub-Release (ggml-org/whisper.cpp). Mit
 * Nvidia-Grafikkarte der CUDA-Build, sonst der normale. Außerhalb von Windows
 * gibt es keine fertigen Builds; dort muss whisper-cli installiert sein.
 */
async function ensureWhisper(variant: Variant, onProgress: OnProgress): Promise<{ exe: string; variant: Variant }> {
  const found = findWhisper(variant);
  if (found) return { exe: found, variant };
  if (!WIN || process.arch !== "x64") {
    throw new Error(
      "Whisper (whisper-cli) nicht gefunden. Auf diesem System bitte whisper.cpp installieren " +
        "(https://github.com/ggml-org/whisper.cpp) und whisper-cli in den PATH legen oder WHISPER_CLI auf die Datei setzen.",
    );
  }
  onProgress({ stage: "setup", message: "Suche aktuelle Version von Whisper …" });
  const releases: any = await (await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } })).json();
  const pick = pickWhisperAsset(Array.isArray(releases) ? releases : [], variant);
  if (!pick) {
    if (variant === "cuda") return ensureWhisper("cpu", onProgress);
    throw new Error("Kein passender Whisper-Download in den aktuellen Releases von whisper.cpp gefunden.");
  }
  const { release, asset } = pick;

  const target = join(WHISPER_DIR, variant);
  await mkdir(WHISPER_DIR, { recursive: true });
  const tmp = await mkdtemp(resolve(WHISPER_DIR, ".download-"));
  try {
    const zip = join(tmp, asset.name);
    const mb = Math.round((asset.size ?? 0) / 1024 / 1024);
    const what = variant === "cuda" ? "Whisper für Nvidia-Grafikkarten" : "Whisper";
    await download(asset.browser_download_url, zip, (percent, eta) =>
      onProgress({ stage: "setup", message: `Lade ${what} ${release.tag_name ?? ""} (${mb} MB, einmalig) …`, percent, eta }),
    );
    const out = join(tmp, "x");
    await mkdir(out);
    const unpacked = spawnSync(tarCommand(), ["-xf", zip, "-C", out], { encoding: "utf8", windowsHide: true });
    if (unpacked.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${unpacked.stderr || unpacked.error?.message}`);
    if (!findFile(out, WHISPER_EXE)) throw new Error(`${WHISPER_EXE} nicht im Download gefunden.`);
    await rm(target, { recursive: true, force: true });
    await rename(out, target);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { exe: findFile(target, WHISPER_EXE)!, variant };
}

async function ensureFfmpeg(onProgress: OnProgress): Promise<string> {
  return ensureFfmpegTool(undefined, (message, percent) => onProgress({ stage: "setup", message, percent }));
}

/** Ist alles für die Sprach-Auswertung mit diesem Modell schon da? */
export async function voiceToolsReady(model: WhisperModel): Promise<{ whisper: boolean; model: boolean }> {
  return { whisper: Boolean(findWhisper(await preferredVariant())), model: existsSync(modelPath(model)) };
}

/** Whisper und Modell jetzt laden statt erst bei der ersten Auswertung. */
export async function prepareVoiceTools(model: WhisperModel, onProgress: OnProgress): Promise<void> {
  await ensureWhisper(await preferredVariant(), onProgress);
  await ensureModel(model, onProgress);
}

// ---- Ton -------------------------------------------------------------------------

/** Startet ein Programm und reicht jede Ausgabezeile weiter. Wirft bei Fehlercode mit den letzten Zeilen. */
function run(exe: string, args: string[], onLine: (line: string) => void, what: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let tail = "";
    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString();
      tail = (tail + data.toString()).slice(-3000);
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => reject(new Error(`${what} konnte nicht gestartet werden: ${err.message}`)));
    child.on("close", (code) => {
      if (buffer) onLine(buffer);
      if (code === 0) return resolveRun();
      reject(Object.assign(explainToolError(tail, what, exe, code), { code }));
    });
  });
}

/** Nur die Tonspur des VODs über TwitchDownloaderCLI ("audio" = Twitchs Audio-only-Stream). */
async function downloadAudio(videoId: string, target: string, ffmpeg: string, onProgress: OnProgress): Promise<void> {
  const tdcli = await ensureTwitchDownloader((message, percent) => onProgress({ stage: "setup", message, percent }));
  const partial = target.replace(/(\.\w+)$/, ".part$1");
  const started = Date.now();
  try {
    await run(
      tdcli,
      ["videodownload", "--id", videoId, "-q", "audio", "-o", partial, "--ffmpeg-path", ffmpeg],
      (line) => {
        // z. B. "[STATUS] - Downloading 42% [2/5]"
        const m = line.match(/\[STATUS\] - ([^\[]*?)\s*(\d+)%/);
        if (!m) return;
        const percent = Number(m[2]);
        const downloading = m[1].startsWith("Downloading");
        onProgress({
          stage: "audio",
          message: downloading ? "Lade Tonspur des VODs …" : "Setze Tonspur zusammen …",
          percent,
          eta: downloading ? remaining(percent, (Date.now() - started) / 1000) : undefined,
        });
      },
      "Download der Tonspur",
    );
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, target);
}

/** Wandelt in 16 kHz Mono-WAV, das Format, das Whisper erwartet. */
async function toWav(ffmpeg: string, input: string, wav: string, length: number | undefined, onProgress: OnProgress): Promise<void> {
  const partial = wav.replace(/\.wav$/, ".part.wav");
  const started = Date.now();
  await run(
    ffmpeg,
    ["-y", "-hide_banner", "-nostats", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-progress", "pipe:1", partial],
    (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (!m || !length) return;
      const percent = Math.min(99, Math.floor((Number(m[1]) / 1e6 / length) * 100));
      onProgress({ stage: "audio", message: "Bereite Ton vor …", percent, eta: remaining(percent, (Date.now() - started) / 1000) });
    },
    "Umwandeln des Tons",
  ).catch(async (err) => {
    await rm(partial, { force: true });
    throw err;
  });
  await rename(partial, wav);
}

/** Wo in einer WAV-Datei die Tondaten beginnen (ffmpeg schreibt teils Zusatzblöcke vor "data"). */
async function wavDataOffset(wav: string): Promise<number> {
  const handle = await open(wav, "r");
  try {
    const head = Buffer.alloc(4096);
    await handle.read(head, 0, head.length, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") throw new Error("Keine WAV-Datei");
    let pos = 12;
    while (pos + 8 <= head.length) {
      const id = head.toString("ascii", pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === "data") return pos + 8;
      pos += 8 + size + (size % 2);
    }
    throw new Error("WAV ohne Datenblock");
  } finally {
    await handle.close();
  }
}

/**
 * Pegel pro Sekunde in dBFS aus 16-Bit-Mono-WAV mit 16 kHz: Effektivwert (RMS)
 * der Samples einer Sekunde, 0 dB = Vollaussteuerung. Gemessen wird der ganze
 * Stream-Ton, also Stimme, Spiel und Musik zusammen.
 */
export async function measureLoudness(wav: string, onPercent: (percent: number) => void = () => {}): Promise<number[]> {
  const offset = await wavDataOffset(wav);
  const rate = 16000;
  const total = Math.max(1, statSync(wav).size - offset);
  const levels: number[] = [];
  let sum = 0;
  let count = 0;
  let read = 0;
  let carry: Buffer | null = null;
  let lastPercent = -1;
  for await (const chunk of createReadStream(wav, { start: offset, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
    let buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    carry = usable < buf.length ? buf.subarray(usable) : null;
    for (let i = 0; i < usable; i += 2) {
      const s = buf.readInt16LE(i);
      sum += s * s;
      if (++count === rate) {
        levels.push(toDb(sum / count));
        sum = 0;
        count = 0;
      }
    }
    read += chunk.length;
    const percent = Math.floor((read / total) * 100);
    if (percent !== lastPercent) onPercent((lastPercent = percent));
  }
  if (count > rate / 4) levels.push(toDb(sum / count));
  return levels;
}

function toDb(meanSquare: number): number {
  if (meanSquare <= 0) return -100;
  return Math.max(-100, Math.round(10 * Math.log10(meanSquare / (32768 * 32768)) * 10) / 10);
}

// ---- Whisper -----------------------------------------------------------------------

interface TranscriptFile {
  model: WhisperModel;
  language: string;
  createdAt: string;
  segments: Segment[];
}

async function readTranscript(dir: string): Promise<TranscriptFile | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, "transcript.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Whisper-JSON (-oj) → Abschnitte in Sekunden */
export function parseWhisperJson(body: any): Segment[] {
  return (body?.transcription ?? [])
    .map((t: any) => ({ start: Number(t.offsets?.from) / 1000, end: Number(t.offsets?.to) / 1000, text: String(t.text ?? "").trim() }))
    .filter((s: Segment) => Number.isFinite(s.start) && s.text && !/^\[.*\]$|^\(.*\)$/.test(s.text));
}

async function transcribe(
  exe: string,
  model: string,
  wav: string,
  language: string,
  onProgress: (percent: number, eta: number | undefined) => void,
): Promise<{ segments: Segment[]; seconds: number }> {
  const outBase = wav.replace(/\.wav$/, ".whisper");
  const started = Date.now();
  const threads = String(Math.max(1, Math.min(8, availableParallelism() - 1)));
  await run(
    exe,
    ["-m", model, "-f", wav, "-l", language, "-t", threads, "-oj", "-of", outBase, "-pp"],
    (line) => {
      // "whisper_print_progress_callback: progress =  42%"
      const m = line.match(/progress\s*=\s*(\d+)%/);
      if (m) onProgress(Number(m[1]), remaining(Number(m[1]), (Date.now() - started) / 1000));
    },
    "Whisper",
  );
  const json = JSON.parse(await readFile(outBase + ".json", "utf8"));
  await rm(outBase + ".json", { force: true });
  return { segments: parseWhisperJson(json), seconds: (Date.now() - started) / 1000 || 1 };
}

// ---- Ablauf ------------------------------------------------------------------------

export interface VoiceResult {
  signals: VoiceSignals;
  /** Was wiederverwendet wurde bzw. womit gerechnet wurde */
  info: { model: WhisperModel; language: string; gpu: boolean; reused: boolean; transcribeSeconds?: number };
}

/**
 * Sprache und Lautstärke eines VODs auswerten. `length` ist die VOD-Länge in
 * Sekunden (für Schätzung und Fortschritt), `dir` der Ordner output/<id>/.
 */
export async function analyzeVoice(
  videoId: string,
  dir: string,
  opts: VoiceOptions,
  length: number | undefined,
  onProgress: OnProgress,
): Promise<VoiceResult> {
  await mkdir(dir, { recursive: true });
  const transcriptFile = join(dir, "transcript.json");
  const loudnessFile = join(dir, "loudness.json");
  let transcript = await readTranscript(dir);
  if (transcript && (transcript.model !== opts.model || transcript.language !== opts.language)) transcript = undefined;
  let levels: number[] | undefined = existsSync(loudnessFile) ? JSON.parse(await readFile(loudnessFile, "utf8")).levels : undefined;
  let variant = await preferredVariant();
  const reused = Boolean(transcript && levels);
  let transcribeSeconds: number | undefined;

  if (!transcript || !levels) {
    // Schätzung für die Gesamt-Restzeit: noch ausstehende Schritte addieren
    const plan = await estimateVoice(length ?? 0, opts.model, dir);
    const pending = new Map(plan.parts.map((p) => [p.label, p.seconds]));
    const later = (...labels: string[]) => labels.reduce((sum, l) => sum + (pending.get(l) ?? 0), 0);
    const transcribeLabel = [...pending.keys()].find((l) => l.startsWith("Transkription")) ?? "";
    // Solange ein Schritt noch keine eigene Hochrechnung hat, gilt die Vorab-Schätzung
    const guess = (label: string, percent: number | undefined) =>
      pending.has(label) && percent !== undefined ? pending.get(label)! * (1 - percent / 100) : undefined;
    const step = (p: VoiceProgress, current: string, ...after: string[]) => {
      const eta = p.eta ?? guess(current, p.percent);
      onProgress({ ...p, eta, totalEta: eta !== undefined ? eta + later(...after) : undefined });
    };
    const setup = "Einmalige Einrichtung";

    const ffmpeg = await ensureFfmpeg((p) => step(p, setup, "Ton laden", "Ton vorbereiten", transcribeLabel));
    let whisper = "";
    let model = "";
    if (!transcript) {
      ({ exe: whisper, variant } = await ensureWhisper(variant, (p) => step(p, setup, "Ton laden", "Ton vorbereiten", transcribeLabel)));
      model = await ensureModel(opts.model, (p) => step(p, setup, "Ton laden", "Ton vorbereiten", transcribeLabel));
    }

    const wav = join(dir, "audio.wav");
    const audio = join(dir, "audio.mp4");
    if (!existsSync(wav)) {
      if (!existsSync(audio)) await downloadAudio(videoId, audio, ffmpeg, (p) => step(p, "Ton laden", "Ton vorbereiten", transcribeLabel));
      await toWav(ffmpeg, audio, wav, length, (p) => step(p, "Ton vorbereiten", transcribeLabel));
    }
    // 16 000 Samples à 2 Byte pro Sekunde
    const audioLength = (statSync(wav).size - (await wavDataOffset(wav))) / 32000;

    if (!levels) {
      onProgress({ stage: "audio", message: "Messe Lautstärke …", percent: 0 });
      levels = await measureLoudness(wav, (percent) => onProgress({ stage: "audio", message: "Messe Lautstärke …", percent }));
      await writeFile(loudnessFile, JSON.stringify({ levels }));
    }

    if (!transcript) {
      const report = (percent: number, eta: number | undefined) => {
        const label = variant === "cuda" ? "Grafikkarte" : "Prozessor";
        eta ??= guess(transcribeLabel, percent);
        onProgress({ stage: "transcribe", message: `Whisper erkennt Sprache (${WHISPER_MODELS[opts.model].label}, ${label}) …`, percent, eta, totalEta: eta });
      };
      report(0, undefined);
      let result: { segments: Segment[]; seconds: number };
      try {
        result = await transcribe(whisper, model, wav, opts.language, report);
      } catch (err) {
        if (variant !== "cuda") throw err;
        // Der Grafikkarten-Build läuft nicht (z. B. zu alter Treiber): mit dem Prozessor weiter und das merken
        const stats = await loadStats();
        await saveStats({ ...stats, cudaBroken: true });
        variant = "cpu";
        onProgress({ stage: "transcribe", message: "Grafikkarte nicht nutzbar, wechsle auf den Prozessor …" });
        ({ exe: whisper } = await ensureWhisper("cpu", onProgress));
        // Die Vorab-Schätzung galt der Grafikkarte, für den Prozessor erst die eigene Hochrechnung
        pending.delete(transcribeLabel);
        result = await transcribe(whisper, model, wav, opts.language, report);
      }
      transcribeSeconds = result.seconds;
      const stats = await loadStats();
      const key = `${variant}:${opts.model}`;
      const measured = audioLength / result.seconds;
      stats.speed[key] = stats.speed[key] ? stats.speed[key] * 0.5 + measured * 0.5 : measured;
      await saveStats(stats);
      transcript = { model: opts.model, language: opts.language, createdAt: new Date().toISOString(), segments: result.segments };
      await writeFile(transcriptFile, JSON.stringify(transcript));
    }

    // Die Ton-Dateien sind groß (ca. 115 MB pro Stunde) und werden nicht mehr gebraucht
    await rm(wav, { force: true });
    await rm(audio, { force: true });
  }

  return {
    signals: {
      segments: transcript.segments,
      keywords: findKeywords(transcript.segments, opts.keywords),
      loud: opts.loudness ? findLoudPeaks(levels, opts) : [],
    },
    info: { model: opts.model, language: opts.language, gpu: variant === "cuda", reused, transcribeSeconds },
  };
}
