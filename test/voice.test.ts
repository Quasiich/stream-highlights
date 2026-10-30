import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTwitchDownloader } from "../src/chat.ts";
import { defaultOptions, findHighlights } from "../src/analyze.ts";
import {
  defaultVoiceOptions,
  estimate,
  findKeywords,
  findLoudPeaks,
  parseKeywords,
  parseVoiceOptions,
  remaining,
  saidDuring,
  type Segment,
} from "../src/voice.ts";
import { measureLoudness, parseWhisperJson } from "../src/whisper.ts";

const seg = (start: number, text: string, end = start + 4): Segment => ({ start, end, text });

test("parseKeywords trennt nach Zeile, Komma und Semikolon und entfernt Doppelte", () => {
  assert.deepEqual(parseKeywords("Clip das\n clip das ,oh mein gott;;\n*\n  clip*  "), ["Clip das", "oh mein gott", "clip*"]);
  assert.deepEqual(parseKeywords(["a", "A!", "b"]), ["a", "b"]);
});

test("findKeywords: ganze Wörter, ohne Groß-/Kleinschreibung und Satzzeichen", () => {
  const segments = [seg(10, " Alter, CLIP DAS!"), seg(50, "Clipboard ist voll"), seg(90, "ich hab das geclippt"), seg(130, "lass uns das clippen")];
  assert.deepEqual(findKeywords(segments, ["clip das"]).map((h) => h.offset), [10]);
  assert.deepEqual(findKeywords(segments, ["clip"]).map((h) => h.offset), [10], "clip passt auf „CLIP DAS“, nicht auf Clipboard oder clippen");
  assert.deepEqual(findKeywords(segments, ["clip*"]).map((h) => h.offset), [10, 50, 130], "Präfix mit *");
});

test("findKeywords findet Sätze über zwei Abschnitte, ohne doppelt zu zählen", () => {
  const segments = [seg(100, "und dann sag ich oh", 103), seg(103, "mein Gott was war das", 107)];
  const hits = findKeywords(segments, ["oh mein gott", "was war das"]);
  assert.deepEqual(hits.map((h) => [h.offset, h.keyword]), [[100, "oh mein gott"], [103, "was war das"]]);
});

test("findKeywords zählt Wiederholungen innerhalb von 10 s nur einmal", () => {
  const segments = [seg(0, "clip das"), seg(4, "clip das clip das"), seg(30, "clip das")];
  assert.deepEqual(findKeywords(segments, ["clip das"]).map((h) => h.offset), [0, 30]);
});

test("findLoudPeaks: relativ zur Umgebung, mit Mindestdauer und ohne Stille", () => {
  const levels = Array.from({ length: 900 }, () => -30);
  for (let i = 300; i < 304; i++) levels[i] = -14; // 4 s, +16 dB
  levels[500] = -10; // nur 1 s: zu kurz
  for (let i = 700; i < 703; i++) levels[i] = -22; // +8 dB: zu wenig
  assert.deepEqual(findLoudPeaks(levels, { loudDb: 12, loudMinSeconds: 2 }), [{ offset: 300, duration: 4, db: 16 }]);
  assert.equal(findLoudPeaks(levels, { loudDb: 6, loudMinSeconds: 2 }).length, 2, "mit +6 dB zählt auch die Stelle bei 700");

  const quiet = Array.from({ length: 600 }, () => -90);
  quiet[100] = quiet[101] = quiet[102] = -70;
  assert.deepEqual(findLoudPeaks(quiet, { loudDb: 12, loudMinSeconds: 2 }), [], "in Stille gibt es keine Peaks");
});

test("findLoudPeaks: eine kurze Pause unterbricht eine laute Stelle nicht", () => {
  const levels = Array.from({ length: 600 }, () => -30);
  for (const i of [200, 201, 203, 204]) levels[i] = -10;
  assert.deepEqual(findLoudPeaks(levels, { loudDb: 12, loudMinSeconds: 2 }), [{ offset: 200, duration: 5, db: 20 }]);
});

test("saidDuring kürzt und nimmt nur Abschnitte im Clip", () => {
  const segments = [seg(0, "vorher"), seg(10, "im Clip"), seg(14, "auch noch"), seg(40, "danach")];
  assert.equal(saidDuring(segments, 9, 20), "im Clip auch noch");
  assert.equal(saidDuring([seg(0, "x".repeat(300))], 0, 5, 50).length, 50);
});

test("parseVoiceOptions begrenzt Werte und fällt auf Standards zurück", () => {
  const v = parseVoiceOptions({ enabled: "on", model: "riesig", language: "fr", keywords: "a, b", loudDb: 999, loudMinSeconds: "", loudTop: 0 });
  assert.equal(v.enabled, true);
  assert.equal(v.model, defaultVoiceOptions.model);
  assert.equal(v.language, "de");
  assert.deepEqual(v.keywords, ["a", "b"]);
  assert.equal(v.loudDb, 40);
  assert.equal(v.loudMinSeconds, defaultVoiceOptions.loudMinSeconds);
  assert.equal(v.loudTop, 0, "0 neue Lautstärke-Highlights ist erlaubt");
  assert.deepEqual(parseVoiceOptions(undefined), defaultVoiceOptions);
});

test("estimate: Bestandteile, Grafikkarte schneller, gemessene Werte engere Spanne", () => {
  const base = { length: 3 * 3600, model: "small" as const, modelMissing: true, whisperMissing: true, ffmpegMissing: false, haveAudio: false, haveTranscript: false };
  const cpu = estimate({ ...base, gpu: false });
  const gpu = estimate({ ...base, gpu: true });
  assert.deepEqual(cpu.parts.map((p) => p.label), ["Einmalige Einrichtung", "Ton laden", "Ton vorbereiten", "Transkription (Prozessor)"]);
  assert.ok(gpu.seconds < cpu.seconds);
  const measured = estimate({ ...base, gpu: true, speed: 50 });
  assert.ok(measured.high / measured.low < gpu.high / gpu.low);
  const done = estimate({ ...base, gpu: true, modelMissing: false, whisperMissing: false, haveTranscript: true });
  assert.equal(done.seconds, 0, "mit vorhandenem Transkript ist nichts zu tun");
});

test("remaining: erst ab etwas Fortschritt eine Zahl", () => {
  assert.equal(remaining(1, 60), undefined);
  assert.equal(remaining(50, 2), undefined);
  assert.equal(remaining(25, 60), 180);
  assert.equal(remaining(100, 60), 0);
});

test("parseWhisperJson liest whisper.cpp-JSON und lässt [Musik] weg", () => {
  const body = {
    transcription: [
      { timestamps: { from: "00:00:00,000", to: "00:00:04,000" }, offsets: { from: 0, to: 4000 }, text: " Hallo zusammen" },
      { timestamps: { from: "00:00:04,000", to: "00:00:09,500" }, offsets: { from: 4000, to: 9500 }, text: " [Musik]" },
      { timestamps: { from: "00:00:09,500", to: "00:00:12,000" }, offsets: { from: 9500, to: 12000 }, text: " Clip das!" },
    ],
  };
  assert.deepEqual(parseWhisperJson(body), [
    { start: 0, end: 4, text: "Hallo zusammen" },
    { start: 9.5, end: 12, text: "Clip das!" },
  ]);
});

test("measureLoudness misst den Pegel pro Sekunde (mit ffmpeg erzeugter Ton)", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg fehlt" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "loud-"));
  const wav = join(dir, "a.wav");
  // 10 s leiser Sinus (-26 dBFS RMS), Sekunde 4–6 deutlich lauter (-6 dBFS RMS)
  const res = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=10",
    "-af", "volume='if(between(t,4,6),0.7071,0.0707)':eval=frame", "-ac", "1", "-c:a", "pcm_s16le", wav,
  ]);
  assert.equal(res.status, 0, res.stderr?.toString());
  const levels = await measureLoudness(wav);
  assert.equal(levels.length, 10);
  // Sinus mit Amplitude A hat RMS A/√2: 0.0707 → -26 dBFS, 0.7071 → -6 dBFS (ffmpegs Sinus hat Amplitude 1/8)
  const quiet = levels[0];
  const loud = levels[4];
  assert.ok(Math.abs(loud - quiet - 20) < 0.5, `Unterschied ${loud - quiet} dB statt 20`);
  assert.deepEqual(findLoudPeaks([...Array(300).fill(quiet), ...levels], { loudDb: 12, loudMinSeconds: 2 }).map((p) => p.offset), [304]);
});

/** Chat ohne Peaks: gleichmäßiges Grundrauschen */
function calmChat(length = 3600) {
  const comments: any[] = [];
  for (let t = 0; t < length; t += 7) {
    comments.push({ content_offset_seconds: t, commenter: { name: `u${t % 13}` }, message: { body: "hallo", fragments: [{ text: "hallo", emoticon: null }] } });
  }
  return parseTwitchDownloader({ video: { id: "1", length }, comments });
}

test("findHighlights: Stichwörter werden immer Highlights, mit Text und Quelle", () => {
  const voice = {
    keywords: [{ offset: 1200, keyword: "clip das", text: "Clip das!" }],
    loud: [],
    segments: [seg(1195, "Was ein Treffer."), seg(1200, "Clip das!")],
  };
  const hl = findHighlights(calmChat(), { ...defaultOptions, voice: { ...defaultVoiceOptions, enabled: true } }, [], voice);
  assert.equal(hl.length, 1);
  assert.deepEqual(hl[0].sources, ["keyword"]);
  assert.equal(hl[0].source, "voice");
  assert.deepEqual(hl[0].keywords, ["clip das"]);
  assert.equal(hl[0].start, 1200 - defaultVoiceOptions.keywordLeadSeconds);
  assert.equal(hl[0].said, "Was ein Treffer. Clip das!");
});

test("findHighlights: Lautstärke wird bei Markern vermerkt, neue Lautstärke-Highlights nur bis loudTop", () => {
  const loud = [
    { offset: 605, duration: 3, db: 18 }, // bei Marker 600
    { offset: 1500, duration: 4, db: 25 },
    { offset: 2500, duration: 4, db: 15 },
    { offset: 3000, duration: 4, db: 20 },
  ];
  const opts = { ...defaultOptions, voice: { ...defaultVoiceOptions, enabled: true, loudTop: 2 } };
  const hl = findHighlights(calmChat(), opts, [{ offset: 600, description: "Boss" }], { keywords: [], loud, segments: [] });
  assert.deepEqual(hl.map((h) => [h.peak, h.sources.join("+"), h.loudDb]), [
    [600, "marker+loud", 18],
    [1500, "loud", 25],
    [3000, "loud", 20],
  ]);
  assert.equal(hl[0].source, "marker+chat", "Kurzform für ältere Oberflächen");
});

test("findHighlights ohne Sprache bleibt wie bisher", () => {
  const hl = findHighlights(calmChat(), defaultOptions, [{ offset: 600, description: "" }]);
  assert.deepEqual(hl.map((h) => h.sources), [["marker"]]);
  assert.equal(hl[0].said, undefined);
});
