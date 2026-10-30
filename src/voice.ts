/**
 * Sprache und Lautstärke als zusätzliche Quellen für Highlights (optional).
 *
 * Whisper schreibt den Ton des VODs mit Zeitstempeln mit. Darin werden selbst
 * festgelegte Stichwörter gesucht. Die Lautstärke misst Whisper nicht, sie wird
 * getrennt aus dem Ton berechnet (siehe whisper.ts, measureLoudness): pro
 * Sekunde der Pegel in dBFS. Ein Lautstärke-Peak ist eine Stelle, die deutlich
 * lauter ist als die Minuten drumherum.
 *
 * Hier steht nur die Auswertung ohne Dateien und Programme, damit sie sich
 * testen lässt.
 */

export type WhisperModel = "base" | "small" | "large-v3-turbo";

export const WHISPER_MODELS: Record<WhisperModel, { label: string; file: string; sizeMb: number }> = {
  base: { label: "Schnell", file: "ggml-base.bin", sizeMb: 148 },
  small: { label: "Ausgewogen", file: "ggml-small.bin", sizeMb: 488 },
  "large-v3-turbo": { label: "Genau", file: "ggml-large-v3-turbo-q5_0.bin", sizeMb: 574 },
};

export interface VoiceOptions {
  enabled: boolean;
  model: WhisperModel;
  /** "de", "en" oder "auto" */
  language: string;
  /** Wörter oder Sätze; "*" am Ende passt auf jede Fortsetzung ("clip*" → "clippen", "clipt") */
  keywords: string[];
  /** Lautstärke-Peaks erkennen */
  loudness: boolean;
  /** So viele dB lauter als die Umgebung (Median der umliegenden Minuten) muss es sein */
  loudDb: number;
  /** So viele Sekunden am Stück */
  loudMinSeconds: number;
  /** Höchstens so viele Lautstärke-Highlights, die nicht ohnehin bei einem anderen liegen */
  loudTop: number;
  /** Vorlauf vor einem Stichwort; gesagt wird es meist erst nach dem Moment */
  keywordLeadSeconds: number;
  keywordTailSeconds: number;
}

export const defaultVoiceOptions: VoiceOptions = {
  enabled: false,
  model: "small",
  language: "de",
  keywords: ["clip das", "clippt das", "oh mein gott", "was war das", "alter was"],
  loudness: true,
  loudDb: 12,
  loudMinSeconds: 2,
  loudTop: 5,
  keywordLeadSeconds: 40,
  keywordTailSeconds: 15,
};

/** Sprach-Einstellungen aus Oberfläche oder Kommandozeile prüfen; Unbekanntes fällt auf den Standard zurück. */
export function parseVoiceOptions(input: any): VoiceOptions {
  const d = defaultVoiceOptions;
  if (!input || typeof input !== "object") return d;
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return value === "" || value === null || value === undefined || !Number.isFinite(n) ? fallback : Math.min(max, Math.max(min, n));
  };
  return {
    ...d,
    enabled: Boolean(input.enabled),
    model: input.model in WHISPER_MODELS ? input.model : d.model,
    language: ["de", "en", "auto"].includes(input.language) ? input.language : d.language,
    keywords: input.keywords === undefined ? d.keywords : parseKeywords(input.keywords),
    loudness: input.loudness === undefined ? d.loudness : Boolean(input.loudness),
    loudDb: clamp(input.loudDb, 3, 40, d.loudDb),
    loudMinSeconds: clamp(input.loudMinSeconds, 1, 30, d.loudMinSeconds),
    loudTop: Math.round(clamp(input.loudTop, 0, 50, d.loudTop)),
  };
}

/** Ein Abschnitt aus Whispers Transkript */
export interface Segment {
  /** Sekunden seit Stream-Beginn */
  start: number;
  end: number;
  text: string;
}

export interface KeywordHit {
  offset: number;
  keyword: string;
  /** Der Satz, in dem es vorkam */
  text: string;
}

export interface LoudPeak {
  /** Beginn der lauten Stelle (Sekunden) */
  offset: number;
  /** Dauer in Sekunden */
  duration: number;
  /** So viele dB lauter als die Umgebung (am lautesten Punkt) */
  db: number;
}

/** Was die Sprach-Auswertung an analyze.ts übergibt */
export interface VoiceSignals {
  keywords: KeywordHit[];
  loud: LoudPeak[];
  segments: Segment[];
}

/** Kleinschreibung, ohne Satzzeichen; Umlaute bleiben. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}*\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "Clip das!" → passt auf "… clip das …"; "clip*" passt auf "clippen". */
function keywordPattern(keyword: string): RegExp | undefined {
  const words = normalize(keyword).split(" ").filter(Boolean);
  if (!words.length) return undefined;
  const parts = words.map((w) => {
    const prefix = w.endsWith("*");
    const core = w.replace(/\*+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return core ? core + (prefix ? "\\p{L}*" : "") : "";
  });
  if (parts.some((p) => !p)) return undefined;
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.join(" ")}(?![\\p{L}\\p{N}])`, "u");
}

/** "clip das, oh mein gott\nwas" → ["clip das", "oh mein gott", "was"] */
export function parseKeywords(input: string | string[]): string[] {
  const list = Array.isArray(input) ? input : input.split(/[\n,;]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const k = String(raw).trim().replace(/\s+/g, " ");
    const key = normalize(k);
    if (!key || key === "*" || seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out.slice(0, 100);
}

/**
 * Sucht die Stichwörter im Transkript. Ein Satz kann über zwei Abschnitte
 * gehen, deshalb wird auch das Ende eines Abschnitts mit dem Anfang des
 * nächsten zusammen durchsucht. Pro Stichwort zählt ein Treffer innerhalb von
 * 10 Sekunden nur einmal.
 */
export function findKeywords(segments: Segment[], keywords: string[]): KeywordHit[] {
  const patterns = keywords.map((k) => ({ keyword: k, re: keywordPattern(k) })).filter((p) => p.re);
  if (!patterns.length) return [];
  const hits: KeywordHit[] = [];
  const last = new Map<string, number>();
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const own = normalize(seg.text);
    const next = segments[i + 1];
    const joined = next && next.start - seg.end < 2 ? `${own} ${normalize(next.text)}` : own;
    for (const { keyword, re } of patterns) {
      if (!re!.test(own) && !(re!.test(joined) && !re!.test(normalize(next!.text)))) continue;
      const prev = last.get(keyword);
      if (prev !== undefined && seg.start - prev < 10) continue;
      last.set(keyword, seg.start);
      hits.push({ offset: seg.start, keyword, text: seg.text.trim() });
    }
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

/** Unter diesem Pegel ist der Ton stumm (Pause, Mikro aus), dort gibt es keine Peaks. */
const SILENCE_DB = -60;

/**
 * Findet Stellen, die mindestens `loudDb` lauter sind als der Median der
 * umliegenden 2,5 Minuten je Seite, und das `loudMinSeconds` am Stück. `levels`
 * ist der Pegel pro Sekunde in dBFS (0 = maximal, -60 = sehr leise).
 */
export function findLoudPeaks(levels: number[], opts: Pick<VoiceOptions, "loudDb" | "loudMinSeconds">, radius = 150): LoudPeak[] {
  if (!levels.length) return [];
  const baseline = rollingMedian(levels, radius);
  const peaks: LoudPeak[] = [];
  let start = -1;
  let best = 0;
  let gap = 0;
  const close = (end: number) => {
    const duration = end - start;
    if (duration >= opts.loudMinSeconds) peaks.push({ offset: start, duration, db: Math.round(best * 10) / 10 });
    start = -1;
    best = 0;
    gap = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const excess = levels[i] - baseline[i];
    const loud = baseline[i] > SILENCE_DB && excess >= opts.loudDb;
    if (loud) {
      if (start < 0) start = i;
      best = Math.max(best, excess);
      gap = 0;
    } else if (start >= 0) {
      // Eine kurze Atempause unterbricht einen Schrei nicht
      if (++gap > 1) close(i - gap + 1);
    }
  }
  if (start >= 0) close(levels.length - gap);
  return peaks;
}

/** Median eines gleitenden Fensters, in Schritten von 5 s berechnet (für Stunden an Sekundenwerten schnell genug). */
function rollingMedian(values: number[], radius: number): number[] {
  const step = 5;
  const out = new Array<number>(values.length);
  for (let c = 0; c < values.length; c += step) {
    const window = values.slice(Math.max(0, c - radius), c + radius + 1).sort((a, b) => a - b);
    const m = window.length % 2 ? window[window.length >> 1] : (window[window.length / 2 - 1] + window[window.length / 2]) / 2;
    for (let i = c; i < Math.min(values.length, c + step); i++) out[i] = m;
  }
  return out;
}

/** Der Text, der während eines Clips gesprochen wurde, gekürzt. */
export function saidDuring(segments: Segment[], start: number, end: number, maxChars = 220): string {
  const text = segments
    .filter((s) => s.end > start && s.start < end)
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  return text.length > maxChars ? text.slice(0, maxChars - 1).trimEnd() + "…" : text;
}

// ---- Zeitschätzung ---------------------------------------------------------

/**
 * Wie viele Sekunden Ton pro Sekunde Rechenzeit, grobe Startwerte. Nach jeder
 * Auswertung werden die gemessenen Werte gespeichert und stattdessen benutzt
 * (whisper.ts, saveSpeed).
 */
export const DEFAULT_SPEED: Record<"gpu" | "cpu", Record<WhisperModel, number>> = {
  gpu: { base: 120, small: 50, "large-v3-turbo": 25 },
  cpu: { base: 10, small: 3.5, "large-v3-turbo": 1.2 },
};

export interface Estimate {
  /** Gesamt in Sekunden, mit Spanne */
  seconds: number;
  low: number;
  high: number;
  parts: { label: string; seconds: number }[];
  gpu: boolean;
  /** Ob die Zahl auf früheren Messungen beruht statt auf Startwerten */
  measured: boolean;
}

export interface EstimateInput {
  /** Länge des VODs in Sekunden */
  length: number;
  model: WhisperModel;
  gpu: boolean;
  /** Gemessene Geschwindigkeit, falls vorhanden */
  speed?: number;
  /** Fehlt noch etwas, das einmalig geladen werden muss? */
  modelMissing: boolean;
  whisperMissing: boolean;
  ffmpegMissing: boolean;
  /** Ton schon heruntergeladen bzw. Transkript schon vorhanden */
  haveAudio: boolean;
  haveTranscript: boolean;
}

/** Angenommene Download-Geschwindigkeit, bewusst vorsichtig (MB/s) */
const DOWNLOAD_MBPS = 8;
/** Ton von Twitch: ca. 160 kbit/s */
const AUDIO_MB_PER_HOUR = 72;

export function estimate(input: EstimateInput): Estimate {
  const parts: { label: string; seconds: number }[] = [];
  const hours = input.length / 3600;
  const setup =
    (input.modelMissing ? WHISPER_MODELS[input.model].sizeMb : 0) + (input.whisperMissing ? (input.gpu ? 450 : 10) : 0) + (input.ffmpegMissing ? 100 : 0);
  if (setup) parts.push({ label: "Einmalige Einrichtung", seconds: setup / DOWNLOAD_MBPS });
  if (!input.haveTranscript && !input.haveAudio) {
    parts.push({ label: "Ton laden", seconds: (hours * AUDIO_MB_PER_HOUR) / DOWNLOAD_MBPS + 10 });
  }
  if (!input.haveTranscript) {
    // Umwandeln und Lautstärke messen: grob 1 s pro 10 min Ton
    parts.push({ label: "Ton vorbereiten", seconds: input.length / 600 + 5 });
    const speed = input.speed ?? DEFAULT_SPEED[input.gpu ? "gpu" : "cpu"][input.model];
    parts.push({ label: input.gpu ? "Transkription (Grafikkarte)" : "Transkription (Prozessor)", seconds: input.length / speed + 15 });
  }
  const seconds = parts.reduce((sum, p) => sum + p.seconds, 0);
  // Ohne Messung ist die Unsicherheit größer
  const spread = input.speed ? [0.8, 1.3] : [0.6, 1.8];
  return { seconds, low: seconds * spread[0], high: seconds * spread[1], parts, gpu: input.gpu, measured: Boolean(input.speed) };
}

/**
 * Restzeit aus bisherigem Fortschritt. Gibt undefined zurück, solange es noch
 * zu früh für eine verlässliche Zahl ist.
 */
export function remaining(percent: number, elapsedSeconds: number): number | undefined {
  if (percent < 2 || elapsedSeconds < 5 || percent >= 100) return percent >= 100 ? 0 : undefined;
  return (elapsedSeconds * (100 - percent)) / percent;
}
