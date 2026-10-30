import type { ChatLog, ChatMessage } from "./chat.ts";
import { defaultEventMinimums, type EventMinimums } from "./events.ts";
import type { Marker } from "./twitch.ts";
import { defaultVoiceOptions, saidDuring, type VoiceOptions, type VoiceSignals } from "./voice.ts";

export interface AnalyzeOptions {
  /** Breite eines Zeitfensters in Sekunden */
  bucketSeconds: number;
  /** Anzahl Chat-Highlights; Streamer-Marker kommen immer zusätzlich dazu */
  top: number;
  /** Mindestabstand zwischen zwei Highlights in Sekunden */
  minGapSeconds: number;
  /** Vorlauf vor dem Chat-Peak (Chat reagiert verzögert) */
  leadSeconds: number;
  /** Nachlauf nach dem Peak */
  tailSeconds: number;
  /** Fenster für die gleitende Grundlinie in Sekunden (je Seite) */
  baselineSeconds: number;
  /** Ab wie viel-facher Normalaktivität ein Fenster als Peak gilt */
  minScore: number;
  /** Vorlauf vor einem Streamer-Marker (der Hotkey wird meist erst danach gedrückt) */
  markerLeadSeconds: number;
  /** Nachlauf nach einem Streamer-Marker */
  markerTailSeconds: number;
  /** Ab wann Gift-Bomben, Raids und Cheers einzeln aufgelistet werden */
  eventMinimums: EventMinimums;
  /** Sprache und Lautstärke (Whisper), standardmäßig aus */
  voice: VoiceOptions;
}

export const defaultOptions: AnalyzeOptions = {
  bucketSeconds: 30,
  top: 10,
  minGapSeconds: 120,
  leadSeconds: 45,
  tailSeconds: 15,
  baselineSeconds: 300,
  minScore: 1.8,
  markerLeadSeconds: 60,
  markerTailSeconds: 30,
  eventMinimums: defaultEventMinimums,
  voice: defaultVoiceOptions,
};

export interface Bucket {
  start: number;
  messages: number;
  chatters: number;
  hype: number;
  /** Rohaktivität, siehe activity() */
  activity: number;
  /** Aktivität relativ zur Grundlinie, 1 = normal */
  score: number;
}

/**
 * Kurzform für ältere Auswertungen und Oberflächen: "marker": vom Streamer
 * markiert, "chat": Chat-Peak, "marker+chat": Marker und weitere Quellen im
 * selben Clip, "voice": nur Stichwort und/oder Lautstärke. Genauer steht es in
 * Highlight.sources.
 */
export type HighlightSource = "marker" | "chat" | "marker+chat" | "voice";

/** Woher ein Highlight kommt; ein Clip kann mehrere haben */
export type Signal = "marker" | "chat" | "keyword" | "loud";

export interface Highlight {
  rank: number;
  source: HighlightSource;
  /** Alle Quellen im Clip, in fester Reihenfolge: marker, keyword, chat, loud */
  sources: Signal[];
  /** Gesagte Stichwörter im Clip */
  keywords: string[];
  /** Lautstärke-Peak im Clip: so viele dB über der Umgebung */
  loudDb?: number;
  /** Was während des Clips gesagt wurde (nur mit Whisper) */
  said?: string;
  /** Beschreibungen der Streamer-Marker im Clip (leer, wenn keine angegeben) */
  markers: string[];
  /** Zeitpunkt des Markers bzw. des Chat-Peaks (Sekunden) */
  peak: number;
  /** Vorgeschlagener Clip */
  start: number;
  end: number;
  /** Stärkster Chat-Ausschlag im Clip */
  score: number;
  messages: number;
  chatters: number;
  topWords: string[];
  sample: string[];
}

/** Pro Person und Zeitfenster zählen höchstens so viele Nachrichten (Spam-Schutz). */
const MAX_PER_USER = 3;

// Emotes und Wörter, die fast immer auf einen lustigen oder spannenden Moment hindeuten.
const HYPE_TOKENS = new Set(
  [
    "lul", "lulw", "kekw", "kek", "omegalul", "icant", "lmao", "lol", "xd", "haha",
    "pog", "pogu", "pogchamp", "poggers", "pogg", "kreygasm", "ez", "clap", "gg",
    "monkas", "monkaw", "wutface", "sadge", "pepehands", "aware", "wtf", "omg",
    "krass", "geil", "digga", "alter", "w", "l", "wow", "?",
  ],
);
const LAUGH = /^(ha){2,}h?$|^x+d+$|^l+o+l+$|^k+e+k+w?$|^a+h+a+h+/i;

// Chat-Bots, deren Nachrichten nichts über die Stimmung im Chat aussagen.
const BOTS = new Set(
  [
    "nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot",
    "sery_bot", "soundalerts", "botrixoficial", "kofistreambot", "pokemoncommunitygame",
  ],
);

// Füllwörter, die in der Wortliste eines Highlights nichts aussagen.
const FILLER_WORDS = new Set(
  [
    // Deutsch
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer",
    "und", "oder", "aber", "doch", "denn", "dass", "weil", "wenn", "als", "wie", "so",
    "ich", "du", "er", "sie", "es", "wir", "ihr", "mich", "dich", "sich", "mir", "dir", "uns", "euch",
    "mein", "meine", "meinem", "meinen", "meiner", "dein", "deine", "sein", "seine",
    "ist", "bin", "bist", "sind", "seid", "war", "hat", "hab", "habe", "hast", "haben", "wird",
    "kann", "muss", "soll", "will", "mal", "noch", "schon", "auch", "nur", "ja", "nein", "nicht",
    "kein", "keine", "in", "im", "an", "am", "auf", "aus", "bei", "mit", "von", "vom", "zu",
    "zum", "zur", "für", "um", "nach", "über", "unter", "vor", "hier", "da", "dann", "jetzt",
    "was", "wer", "wo", "man", "halt", "eh", "eig", "ne", "nen", "nem", "gibt", "gerade", "grad",
    // Englisch
    "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "to", "of", "in",
    "on", "at", "for", "it", "this", "that", "you", "he", "she", "we", "they", "my", "your",
    "me", "so", "just", "with", "have", "has", "do", "not", "no", "yes", "what", "im",
  ],
);

/**
 * Bot-Befehle (z. B. "!50" fürs Giveaway, "!tb") und Nachrichten von Chat-Bots
 * zählen nicht als Reaktion des Chats. Subs, Raids und Bits auch nicht: Sie
 * sagen nichts darüber, ob im Stream gerade etwas Clip-würdiges passiert, und
 * werden separat über collectEvents() ausgegeben.
 */
export function isNoise(msg: ChatMessage): boolean {
  return Boolean(msg.event) || msg.text.trimStart().startsWith("!") || BOTS.has(msg.user.toLowerCase());
}

export function isFillerWord(word: string): boolean {
  return FILLER_WORDS.has(word.toLowerCase().replace(/[!?.,:;]+$/, ""));
}

export function hypeCount(msg: ChatMessage): number {
  let n = msg.emotes.filter((e) => HYPE_TOKENS.has(e.toLowerCase())).length;
  for (const word of msg.text.split(/\s+/)) {
    const w = word.toLowerCase().replace(/[!.,]+$/, "");
    if (msg.emotes.includes(word)) continue; // schon gezählt
    if (HYPE_TOKENS.has(w) || LAUGH.test(w) || /^\?{2,}$/.test(w)) n++;
  }
  // Mehrfach-Spam in einer Nachricht zählt maximal 3-fach
  return Math.min(n, 3);
}

/**
 * Wie "laut" ein Zeitfenster ist. Verschiedene Chatter zählen mehr als
 * Nachrichten, damit ein einzelner Spammer keine Highlights erzeugt.
 */
function activity(b: Omit<Bucket, "activity" | "score">): number {
  return b.chatters * 1.0 + b.messages * 0.3 + b.hype * 0.5;
}

export function buildBuckets(log: ChatLog, opts: AnalyzeOptions = defaultOptions): Bucket[] {
  const last = log.length ?? log.messages.at(-1)?.offset ?? 0;
  const count = Math.max(1, Math.ceil((last + 1) / opts.bucketSeconds));
  const raw = Array.from({ length: count }, (_, i) => ({
    start: i * opts.bucketSeconds,
    messages: 0,
    perUser: new Map<string, number>(),
    hype: 0,
  }));

  for (const m of log.messages) {
    if (isNoise(m)) continue;
    const b = raw[Math.min(count - 1, Math.floor(m.offset / opts.bucketSeconds))];
    const seen = b.perUser.get(m.user) ?? 0;
    b.perUser.set(m.user, seen + 1);
    if (seen >= MAX_PER_USER) continue;
    b.messages++;
    b.hype += hypeCount(m);
  }

  const buckets = raw.map(({ perUser, ...b }) => {
    const base = { ...b, chatters: perUser.size };
    return { ...base, activity: activity(base), score: 0 };
  });

  // Gleitender Median als Grundlinie: der Chat ist am Anfang und Ende eines
  // Streams oft ruhiger, absolute Werte wären deshalb unfair.
  const radius = Math.max(1, Math.round(opts.baselineSeconds / opts.bucketSeconds));
  const overallMedian = median(buckets.map((b) => b.activity));
  const floor = Math.max(2, overallMedian * 0.5);
  for (let i = 0; i < buckets.length; i++) {
    const window = buckets.slice(Math.max(0, i - radius), i + radius + 1).map((b) => b.activity);
    const baseline = Math.max(floor, median(window));
    buckets[i].score = buckets[i].activity / baseline;
  }
  return buckets;
}

/** Höchstens so viele Stichwort-Treffer werden zu Highlights (ein zu allgemeines Stichwort soll die Liste nicht fluten) */
const MAX_KEYWORD_HIGHLIGHTS = 50;
/** Ein Schrei kommt meist kurz nach dem Moment */
const LOUD_LEAD_SECONDS = 30;
const LOUD_TAIL_SECONDS = 10;

/**
 * Streamer-Marker und gesagte Stichwörter werden immer zu Highlights und
 * stehen vorne. Danach folgen bis zu `top` Chat-Peaks und bis zu
 * `voice.loudTop` Lautstärke-Peaks. Was zeitlich zusammenfällt, wird zu einem
 * Clip mit mehreren Quellen zusammengeführt.
 */
export function findHighlights(log: ChatLog, opts: AnalyzeOptions = defaultOptions, markers: Marker[] = [], voice?: VoiceSignals): Highlight[] {
  const buckets = buildBuckets(log, opts);
  const voiceOpts = { ...defaultVoiceOptions, ...opts.voice };
  const length =
    log.length ??
    Math.max(
      buckets.at(-1)!.start + opts.bucketSeconds,
      ...markers.map((m) => m.offset),
      ...(voice?.keywords ?? []).map((k) => k.offset),
      ...(voice?.loud ?? []).map((l) => l.offset + l.duration),
    );
  const indexAt = (seconds: number) => Math.max(0, Math.min(buckets.length - 1, Math.floor(seconds / opts.bucketSeconds)));

  // Ein Highlight braucht relativ (Score) und absolut (Aktivität) genug Ausschlag.
  const minActivity = Math.max(3, median(buckets.map((b) => b.activity)));
  const candidates = buckets
    .filter((b) => b.score >= opts.minScore && b.activity >= minActivity)
    .sort((a, b) => b.score * Math.sqrt(b.activity) - a.score * Math.sqrt(a.activity));

  // Clip so weit verlängern, wie benachbarte Fenster ebenfalls aktiv sind.
  const clipOf = (b: Bucket): Clip => {
    let from = buckets.indexOf(b);
    let to = from;
    while (from > 0 && buckets[from - 1].score >= opts.minScore && b.start - buckets[from - 1].start < 60) from--;
    while (to < buckets.length - 1 && buckets[to + 1].score >= opts.minScore && buckets[to + 1].start - b.start < 60) to++;
    return {
      kinds: new Set(["chat"]),
      markers: [],
      keywords: [],
      anchor: b.start,
      peak: b,
      from,
      to,
      start: Math.max(0, buckets[from].start - opts.leadSeconds),
      end: Math.min(length, buckets[to].start + opts.bucketSeconds + opts.tailSeconds),
    };
  };

  // Clip um einen festen Zeitpunkt (Marker, Stichwort, Lautstärke). Für Score
  // und Chatter zählt die stärkste Chat-Reaktion im Clip.
  const fixedClip = (kind: Signal, at: number, start: number, end: number): Clip => {
    start = Math.max(0, start);
    end = Math.min(length, end);
    const from = indexAt(start);
    const to = Math.max(from, indexAt(end - 1));
    const peak = buckets.slice(from, to + 1).reduce((best, b) => (b.score > best.score ? b : best));
    return { kinds: new Set([kind]), markers: [], keywords: [], anchor: at, peak, from, to, start, end };
  };
  const markerClipOf = (m: Marker): Clip => ({
    ...fixedClip("marker", m.offset, m.offset - opts.markerLeadSeconds, m.offset + opts.markerTailSeconds),
    markers: m.description ? [m.description] : [],
  });

  // Liegt ein Kandidat zu nah an einem gewählten Highlight oder überlappen
  // sich die Clips, wird er in dieses Highlight eingeschmolzen statt doppelt
  // aufzutauchen. Der Zeitpunkt des zuerst gewählten bleibt.
  const near = (a: Clip, b: Clip) =>
    Math.abs(a.anchor - b.anchor) < opts.minGapSeconds || (a.start < b.end && b.start < a.end);
  const picked: Clip[] = [];
  const add = (clip: Clip) => {
    const first = picked.find((p) => near(p, clip));
    if (!first) {
      picked.push(clip);
      return;
    }
    let host: Clip = first;
    merge(host, clip);
    // Der verlängerte Clip kann jetzt weitere Highlights berühren; das höher
    // platzierte bleibt bestehen.
    for (let other = picked.find((p) => p !== host && near(host, p)); other; other = picked.find((p) => p !== host && near(host, p))) {
      const [keep, drop]: Clip[] = picked.indexOf(other) < picked.indexOf(host) ? [other, host] : [host, other];
      merge(keep, drop);
      picked.splice(picked.indexOf(drop), 1);
      host = keep;
    }
  };

  for (const m of [...markers].sort((a, b) => a.offset - b.offset)) add(markerClipOf(m));
  for (const k of (voice?.keywords ?? []).slice(0, MAX_KEYWORD_HIGHLIGHTS)) {
    add({
      ...fixedClip("keyword", k.offset, k.offset - voiceOpts.keywordLeadSeconds, k.offset + voiceOpts.keywordTailSeconds),
      keywords: [k.keyword],
    });
  }
  let chatCount = 0;
  for (const c of candidates) {
    if (chatCount >= opts.top) break;
    const clip = clipOf(c);
    if (!picked.some((p) => near(p, clip))) chatCount++;
    add(clip);
  }
  // Lautstärke: stärkste zuerst. Liegt ein Peak bei einem vorhandenen Highlight,
  // wird er nur dort vermerkt; neue Highlights gibt es höchstens loudTop.
  let loudCount = 0;
  for (const l of [...(voice?.loud ?? [])].sort((a, b) => b.db - a.db)) {
    const clip = { ...fixedClip("loud", l.offset, l.offset - LOUD_LEAD_SECONDS, l.offset + l.duration + LOUD_TAIL_SECONDS), loudDb: l.db };
    if (!picked.some((p) => near(p, clip))) {
      if (loudCount >= voiceOpts.loudTop) continue;
      loudCount++;
    }
    add(clip);
  }

  return picked.map((clip, i) => {
    const b = clip.peak;
    const msgs = log.messages.filter(
      (m) => !isNoise(m) && m.offset >= buckets[clip.from].start && m.offset < buckets[clip.to].start + opts.bucketSeconds,
    );

    const sources = (["marker", "keyword", "chat", "loud"] as const).filter((k) => clip.kinds.has(k));
    return {
      rank: i + 1,
      source: legacySource(clip.kinds),
      sources,
      keywords: [...new Set(clip.keywords)],
      ...(clip.loudDb !== undefined ? { loudDb: clip.loudDb } : {}),
      ...(voice?.segments.length ? { said: saidDuring(voice.segments, clip.start, clip.end) } : {}),
      markers: clip.markers,
      peak: clip.anchor,
      start: clip.start,
      end: clip.end,
      score: round(b.score),
      messages: b.messages,
      chatters: b.chatters,
      topWords: topWords(msgs, 5),
      sample: msgs.filter((m) => m.text.length > 3).slice(0, 5).map((m) => `${m.user}: ${m.text}`),
    };
  });
}

interface Clip {
  kinds: Set<Signal>;
  markers: string[];
  keywords: string[];
  loudDb?: number;
  /** Zeitpunkt des Markers bzw. Chat-Peaks, nach dem der Clip benannt ist */
  anchor: number;
  /** Stärkstes Chat-Fenster des Clips */
  peak: Bucket;
  /** Index des ersten und letzten Fensters in buckets */
  from: number;
  to: number;
  start: number;
  end: number;
}

/** Erweitert `host` um `other`; der Zeitpunkt von `host` bleibt (er wurde zuerst gewählt). */
function merge(host: Clip, other: Clip): void {
  for (const k of other.kinds) host.kinds.add(k);
  host.markers = [...host.markers, ...other.markers];
  host.keywords = [...host.keywords, ...other.keywords];
  if (other.loudDb !== undefined) host.loudDb = Math.max(host.loudDb ?? -Infinity, other.loudDb);
  if (other.peak.score > host.peak.score) host.peak = other.peak;
  host.from = Math.min(host.from, other.from);
  host.to = Math.max(host.to, other.to);
  host.start = Math.min(host.start, other.start);
  host.end = Math.max(host.end, other.end);
}

function legacySource(kinds: Set<Signal>): HighlightSource {
  if (kinds.has("marker")) return kinds.size > 1 ? "marker+chat" : "marker";
  return kinds.has("chat") ? "chat" : "voice";
}

function topWords(msgs: ChatMessage[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    // Jedes Wort pro Nachricht nur einmal, sonst gewinnt der Spam
    for (const w of new Set(m.text.split(/\s+/).filter((w) => w.length > 1 && !isFillerWord(w)))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w, c]) => `${w} ×${c}`);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
