import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTwitchDownloader } from "../src/chat.ts";
import { defaultOptions, findHighlights, hypeCount, isNoise } from "../src/analyze.ts";
import { collectEvents, isNotable, summarize } from "../src/events.ts";
import { clock, twitchTime } from "../src/format.ts";

/**
 * Künstlicher 2-Stunden-Chat im TwitchDownloader-Format: ruhiges Grundrauschen,
 * dazu drei eingebaute Peaks und ein einzelner Spammer.
 */
function syntheticChat() {
  const comments: any[] = [];
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const add = (t: number, user: string, body: string, extra: any = {}) =>
    comments.push({
      content_offset_seconds: t,
      commenter: { name: user, display_name: user },
      message: { body, fragments: [{ text: body, emoticon: null }], ...extra },
    });

  for (let t = 0; t < 7200; t += 4 + rand() * 8) add(t, `user${Math.floor(rand() * 30)}`, "hallo wie gehts");

  const peak = (at: number, word: string) => {
    for (let i = 0; i < 60; i++) add(at + rand() * 25, `fan${i}`, `${word} ${word}`);
  };
  peak(1800, "KEKW"); // 0:30:00
  peak(4500, "POG"); // 1:15:00
  peak(6600, "LUL"); // 1:50:00

  for (let i = 0; i < 80; i++) add(3000 + i * 0.3, "spammer", "aaaaaaaaaaaa");
  add(5400, "raider", "raid!", { user_notice_params: { "msg-id": "raid" } });

  return { video: { id: "123456789", title: "Testvod", length: 7200 }, streamer: { name: "tester" }, comments };
}

test("findet die eingebauten Peaks in der richtigen Reihenfolge der Zeit", () => {
  const log = parseTwitchDownloader(syntheticChat());
  const hl = findHighlights(log, { ...defaultOptions, bucketSeconds: 30, top: 3, minGapSeconds: 120, leadSeconds: 45, tailSeconds: 15, baselineSeconds: 300 });
  const peaks = hl.map((h) => h.peak).sort((a, b) => a - b);
  assert.deepEqual(peaks, [1800, 4500, 6600]);
  for (const h of hl) {
    assert.ok(h.start < h.peak && h.end > h.peak, "Clip umschließt den Peak");
    assert.ok(h.start <= h.peak - 45, "Vorlauf vor dem Chat-Peak");
  }
});

test("ein einzelner Spammer erzeugt kein Highlight", () => {
  const log = parseTwitchDownloader(syntheticChat());
  const hl = findHighlights(log, { ...defaultOptions, bucketSeconds: 30, top: 10, minGapSeconds: 120, leadSeconds: 45, tailSeconds: 15, baselineSeconds: 300 });
  assert.ok(!hl.some((h) => h.peak >= 2970 && h.peak <= 3030), JSON.stringify(hl.map((h) => h.peak)));
});

test("Bot-Befehle und Bot-Nachrichten erzeugen kein Highlight", () => {
  const raw = syntheticChat();
  // Giveaway: 200 verschiedene Leute tippen "!50", dazu antwortet ein Bot
  for (let i = 0; i < 200; i++) {
    raw.comments.push({
      content_offset_seconds: 2400 + (i % 25),
      commenter: { name: `giveaway${i}` },
      message: { body: "!50", fragments: [{ text: "!50", emoticon: null }] },
    });
    raw.comments.push({
      content_offset_seconds: 2400 + (i % 25),
      commenter: { name: "StreamElements" },
      message: { body: `@giveaway${i} du bist dabei`, fragments: [{ text: "x", emoticon: null }] },
    });
  }
  const log = parseTwitchDownloader(raw);
  const hl = findHighlights(log, { ...defaultOptions, top: 10 });
  assert.ok(!hl.some((h) => h.peak >= 2370 && h.peak <= 2430), JSON.stringify(hl.map((h) => h.peak)));
  for (const h of hl) assert.ok(!h.topWords.some((w) => w.startsWith("!")), h.topWords.join(", "));
});

test("Füllwörter tauchen nicht in den Top-Wörtern auf", () => {
  const raw = syntheticChat();
  for (let i = 0; i < 60; i++) {
    const body = "das ist so KEKW und ich kann nicht mehr";
    raw.comments.push({
      content_offset_seconds: 1800 + i * 0.4,
      commenter: { name: `lacher${i}` },
      message: { body, fragments: [{ text: body, emoticon: null }] },
    });
  }
  const hl = findHighlights(parseTwitchDownloader(raw), { ...defaultOptions, top: 3 });
  const words = hl.find((h) => h.peak === 1800)!.topWords.map((w) => w.split(" ")[0]);
  assert.ok(words.includes("KEKW"), words.join(", "));
  for (const filler of ["das", "ist", "so", "und", "ich", "kann", "nicht"]) assert.ok(!words.includes(filler), words.join(", "));
});

test("Clips überlappen sich nicht, nahe Peaks werden zusammengeführt", () => {
  const raw = syntheticChat();
  // Zweiter Peak 1 Minute nach dem KEKW-Peak bei 0:30:00
  for (let i = 0; i < 60; i++) {
    raw.comments.push({
      content_offset_seconds: 1860 + i * 0.4,
      commenter: { name: `gz${i}` },
      message: { body: "gz gz", fragments: [{ text: "gz gz", emoticon: null }] },
    });
  }
  const hl = findHighlights(parseTwitchDownloader(raw), { ...defaultOptions, top: 10 });
  const sorted = [...hl].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].start >= sorted[i - 1].end, `Überlappung: ${JSON.stringify(sorted.map((h) => [h.start, h.end]))}`);
  }
  const merged = hl.find((h) => h.start <= 1800 && h.end >= 1890);
  assert.ok(merged, "ein Clip deckt beide Peaks ab");
  assert.deepEqual(hl.map((h) => h.rank), hl.map((_, i) => i + 1));
});

test("isNoise erkennt Befehle, Bots und Events", () => {
  const msg = (text: string, user = "a", event?: string) => ({ offset: 0, user, text, emotes: [], event });
  assert.equal(isNoise(msg("!50")), true);
  assert.equal(isNoise(msg("  !tb")), true);
  assert.equal(isNoise(msg("hallo", "Nightbot")), true);
  assert.equal(isNoise(msg("Cheer100 <3", "a", "bits")), true);
  assert.equal(isNoise(msg("KEKW !!!")), false);
});

test("erkennt Subs, Gift-Bomben, Raids und Bits im TwitchDownloader-Format", () => {
  const line = (user: string, body: string, extra: any = {}) => ({
    content_offset_seconds: 100,
    commenter: { name: user.toLowerCase(), display_name: user },
    message: { body, fragments: [{ text: body, emoticon: null }], ...extra },
  });
  const log = parseTwitchDownloader({
    comments: [
      line("AFKStefan", "AFKStefan subscribed with Prime. "),
      line("flo_flg", "flo_flg subscribed at Tier 1. They've subscribed for 8 months, currently on a 3 month streak! "),
      line("Viris26", "Viris26 is gifting 5 Tier 1 Subs to metashi12's community! They've gifted a total of 594 in the channel! "),
      line("Viris26", "Viris26 gifted a Tier 1 sub to sambicas! "),
      line("Raider", "Raider is raiding with a party of 250."),
      line("fan", "Cheer100 <3", { bits_spent: 100 }),
      line("troll", "AFKStefan subscribed with Prime. "),
      line("chatter", "subscribed at Tier 1 lol"),
    ],
  });
  assert.deepEqual(
    log.messages.map((m) => [m.event, m.amount]),
    [["sub", undefined], ["resub", 8], ["submysterygift", 5], ["subgift", undefined], ["raid", 250], ["bits", 100], [undefined, undefined], [undefined, undefined]],
  );
});

test("collectEvents fasst Gift-Bomben zusammen und zählt richtig", () => {
  const ev = (offset: number, user: string, event: string, amount?: number) => ({ offset, user, text: "", emotes: [], event, amount });
  const log = {
    messages: [
      ev(10, "gifter", "subgift"), // Geschenk-Zeile vor der Ankündigung
      ev(10, "gifter", "submysterygift", 2),
      ev(12, "gifter", "subgift"),
      ev(200, "gifter", "subgift"), // eigenständiges Geschenk, nicht Teil der Bombe
      ev(300, "a", "resub", 12),
      ev(400, "b", "bits", 500),
      ev(500, "c", "raid", 80),
    ],
  };
  const events = collectEvents(log);
  assert.deepEqual(events.map((e) => e.offset), [10, 200, 400, 500], "Resub fällt raus");
  assert.deepEqual(summarize(events), { subs: 0, giftedSubs: 3, raids: 1, bits: 500 });
});

test("isNotable listet nur Gift-Bomben ab 5, Raids ab 10 und Cheers ab 500", () => {
  const ev = (type: string, amount?: number) => ({ offset: 0, user: "a", type, amount });
  assert.equal(isNotable(ev("submysterygift", 4)), false);
  assert.equal(isNotable(ev("submysterygift", 5)), true);
  assert.equal(isNotable(ev("subgift")), false);
  assert.equal(isNotable(ev("sub")), false);
  assert.equal(isNotable(ev("raid", 8)), false);
  assert.equal(isNotable(ev("raid", 10)), true);
  assert.equal(isNotable(ev("bits", 499)), false);
  assert.equal(isNotable(ev("bits", 500)), true);
});

test("Subs erzeugen kein Highlight", () => {
  const raw = syntheticChat();
  for (let i = 0; i < 150; i++) {
    const body = `sub${i} subscribed at Tier 1. `;
    raw.comments.push({ content_offset_seconds: 2400 + i * 0.2, commenter: { name: `sub${i}` }, message: { body, fragments: [{ text: body, emoticon: null }] } });
  }
  const hl = findHighlights(parseTwitchDownloader(raw), { ...defaultOptions, top: 10 });
  assert.ok(!hl.some((h) => h.peak >= 2370 && h.peak <= 2430), JSON.stringify(hl.map((h) => h.peak)));
});

test("hypeCount erkennt Emotes, Lachen und Fragezeichen, gedeckelt auf 3", () => {
  const msg = (text: string) => ({ offset: 0, user: "a", text, emotes: [] });
  assert.equal(hypeCount(msg("hallo zusammen")), 0);
  assert.equal(hypeCount(msg("KEKW")), 1);
  assert.equal(hypeCount(msg("hahahaha xD")), 2);
  assert.equal(hypeCount(msg("???")), 1);
  assert.equal(hypeCount(msg("LUL LUL LUL LUL LUL")), 3);
});

test("Zeitformate", () => {
  assert.equal(clock(65), "1:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(twitchTime(3725), "1h02m05s");
});
