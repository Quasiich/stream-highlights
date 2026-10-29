import type { ChatLog, ChatMessage } from "./chat.ts";

export interface AnalyzeOptions {
  /** Breite eines Zeitfensters in Sekunden */
  bucketSeconds: number;
  /** Anzahl Highlights, die ausgegeben werden */
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
}

export const defaultOptions: AnalyzeOptions = {
  bucketSeconds: 30,
  top: 10,
  minGapSeconds: 120,
  leadSeconds: 45,
  tailSeconds: 15,
  baselineSeconds: 300,
  minScore: 1.8,
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

export interface Highlight {
  rank: number;
  /** Peak-Zeitpunkt (Sekunden) */
  peak: number;
  /** Vorgeschlagener Clip */
  start: number;
  end: number;
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

export function findHighlights(log: ChatLog, opts: AnalyzeOptions = defaultOptions): Highlight[] {
  const buckets = buildBuckets(log, opts);
  const length = log.length ?? (buckets.at(-1)!.start + opts.bucketSeconds);

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
      peak: b,
      from,
      to,
      start: Math.max(0, buckets[from].start - opts.leadSeconds),
      end: Math.min(length, buckets[to].start + opts.bucketSeconds + opts.tailSeconds),
    };
  };

  // Liegt ein Kandidat zu nah an einem gewählten Highlight oder überlappen
  // sich die Clips, wird er in dieses Highlight eingeschmolzen statt doppelt
  // aufzutauchen. Der stärkere Peak bleibt der Peak.
  const near = (a: Clip, b: Clip) =>
    Math.abs(a.peak.start - b.peak.start) < opts.minGapSeconds || (a.start < b.end && b.start < a.end);
  const picked: Clip[] = [];
  for (const c of candidates) {
    if (picked.length >= opts.top) break;
    const clip = clipOf(c);
    const first = picked.find((p) => near(p, clip));
    if (!first) {
      picked.push(clip);
      continue;
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
  }

  return picked.map((clip, i) => {
    const b = clip.peak;
    const msgs = log.messages.filter(
      (m) => !isNoise(m) && m.offset >= buckets[clip.from].start && m.offset < buckets[clip.to].start + opts.bucketSeconds,
    );

    return {
      rank: i + 1,
      peak: b.start,
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
  /** Stärkstes Fenster des Clips */
  peak: Bucket;
  /** Index des ersten und letzten Fensters in buckets */
  from: number;
  to: number;
  start: number;
  end: number;
}

/** Erweitert `host` um `other`; der Peak von `host` bleibt (er wurde zuerst gewählt). */
function merge(host: Clip, other: Clip): void {
  host.from = Math.min(host.from, other.from);
  host.to = Math.max(host.to, other.to);
  host.start = Math.min(host.start, other.start);
  host.end = Math.max(host.end, other.end);
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
