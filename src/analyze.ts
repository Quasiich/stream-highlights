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
  events: number;
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
  return b.chatters * 1.0 + b.messages * 0.3 + b.hype * 0.5 + b.events * 2;
}

export function buildBuckets(log: ChatLog, opts: AnalyzeOptions = defaultOptions): Bucket[] {
  const last = log.length ?? log.messages.at(-1)?.offset ?? 0;
  const count = Math.max(1, Math.ceil((last + 1) / opts.bucketSeconds));
  const raw = Array.from({ length: count }, (_, i) => ({
    start: i * opts.bucketSeconds,
    messages: 0,
    perUser: new Map<string, number>(),
    hype: 0,
    events: 0,
  }));

  for (const m of log.messages) {
    const b = raw[Math.min(count - 1, Math.floor(m.offset / opts.bucketSeconds))];
    const seen = b.perUser.get(m.user) ?? 0;
    b.perUser.set(m.user, seen + 1);
    if (seen >= MAX_PER_USER) continue;
    b.messages++;
    b.hype += hypeCount(m);
    if (m.event) b.events++;
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

  const picked: Bucket[] = [];
  for (const c of candidates) {
    if (picked.length >= opts.top) break;
    if (picked.some((p) => Math.abs(p.start - c.start) < opts.minGapSeconds)) continue;
    picked.push(c);
  }

  return picked.map((b, i) => {
    // Clip so weit verlängern, wie benachbarte Fenster ebenfalls aktiv sind.
    let from = buckets.indexOf(b);
    let to = from;
    while (from > 0 && buckets[from - 1].score >= opts.minScore && b.start - buckets[from - 1].start < 60) from--;
    while (to < buckets.length - 1 && buckets[to + 1].score >= opts.minScore && buckets[to + 1].start - b.start < 60) to++;

    const msgs = log.messages.filter(
      (m) => m.offset >= buckets[from].start && m.offset < buckets[to].start + opts.bucketSeconds,
    );

    return {
      rank: i + 1,
      peak: b.start,
      start: Math.max(0, buckets[from].start - opts.leadSeconds),
      end: Math.min(length, buckets[to].start + opts.bucketSeconds + opts.tailSeconds),
      score: round(b.score),
      messages: b.messages,
      chatters: b.chatters,
      topWords: topWords(msgs, 5),
      sample: msgs.filter((m) => m.text.length > 3).slice(0, 5).map((m) => `${m.user}: ${m.text}`),
    };
  });
}

function topWords(msgs: ChatMessage[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    // Jedes Wort pro Nachricht nur einmal, sonst gewinnt der Spam
    for (const w of new Set(m.text.split(/\s+/).filter((w) => w.length > 1))) {
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
