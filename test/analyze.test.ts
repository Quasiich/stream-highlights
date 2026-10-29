import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTwitchDownloader } from "../src/chat.ts";
import { defaultOptions, findHighlights, hypeCount } from "../src/analyze.ts";
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
