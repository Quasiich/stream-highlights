import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveProgress } from "../src/liveprogress.ts";
import { defaultClipSettings, estimateClipSeconds } from "../src/clips.ts";

test("LiveProgress übernimmt die Whisper-Restzeit und rechnet die Clips dazu", () => {
  const p = new LiveProgress(() => 0);
  p.update("analyze", { stage: "transcribe", message: "Whisper …", percent: 40, eta: 120, totalEta: 150 }, 30);
  assert.equal(p.get()?.eta, 120);
  assert.equal(p.get()?.totalEta, 180, "Whisper-Rest plus Clips");
  p.update("analyze", { stage: "analyze", message: "Werte Chat aus …" }, 30);
  assert.equal(p.get()?.totalEta, 30, "ohne eigene Restzeit bleiben die Clips");
});

test("LiveProgress rechnet ohne gemeldete Restzeit aus dem Fortschritt hoch", () => {
  let now = 0;
  const p = new LiveProgress(() => now);
  p.update("clips", { stage: "clips", message: "Clip 1/4 …", percent: 0 });
  assert.equal(p.get()?.totalEta, undefined, "am Anfang noch keine Schätzung");
  now = 20_000;
  p.update("clips", { stage: "clips", message: "Clip 2/4 …", percent: 25 });
  assert.equal(p.get()?.eta, 60, "25 % in 20 s, also noch 60 s");
  assert.equal(p.get()?.totalEta, 60);
  assert.equal(p.get()?.phase, "clips");

  p.reset();
  assert.equal(p.get(), undefined);
});

test("estimateClipSeconds schätzt nach Anzahl, Länge und fehlendem ffmpeg", () => {
  const fixed = { ...defaultClipSettings, mode: "fixed" as const, count: 2, lengthSeconds: 60 };
  assert.equal(estimateClipSeconds(fixed), 2 * (2 + 1.2));
  assert.equal(estimateClipSeconds(fixed, true), 2 * (2 + 1.2) + 30);
  assert.ok(estimateClipSeconds({ ...defaultClipSettings, count: 5 }) > estimateClipSeconds({ ...defaultClipSettings, count: 1 }));
});
