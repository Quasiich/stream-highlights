import { test } from "node:test";
import assert from "node:assert/strict";
import type { Highlight } from "../src/analyze.ts";
import { normalizeAutomation } from "../src/automation.ts";
import { clipFileName, clipRanges, defaultClipSettings } from "../src/clips.ts";
import { DEFAULT_MESSAGE, escapeMarkdown, highlightsMessage, isWebhookUrl, postToAll, postToDiscord, renderMessage, testMessage } from "../src/discord.ts";
import type { Report } from "../src/pipeline.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abc-DEF_42";

function highlight(rank: number, peak: number, start: number, end: number, extra: Partial<Highlight> = {}): Highlight {
  return { rank, source: "chat", markers: [], peak, start, end, score: 3.2, messages: 40, chatters: 12, topWords: ["kekw"], sample: [], ...extra };
}

function report(highlights: Highlight[]): Report {
  return {
    video: { id: "2912392719", title: "Dienstagsmodus", channel: "scuse", length: 8000 },
    analyzedAt: "2026-10-30T20:00:00.000Z",
    messageCount: 261,
    highlights,
    markers: [],
    events: { summary: { subs: 2, giftedSubs: 0, raids: 1, bits: 0 }, list: [], minimums: { giftedSubs: 5, raidViewers: 10, bits: 500 } },
  };
}

test("Clips wie das Highlight: Puffer dazu, sortiert nach Rang, nur die gewünschte Anzahl", () => {
  const list = [highlight(2, 1000, 960, 1020), highlight(1, 500, 455, 515), highlight(3, 2000, 1955, 2015)];
  assert.deepEqual(clipRanges(list, { ...defaultClipSettings, count: 2, paddingSeconds: 5 }), [
    { rank: 1, start: 450, end: 520 },
    { rank: 2, start: 955, end: 1025 },
  ]);
});

test("zu lange Highlights werden um den Peak herum gekürzt", () => {
  const [clip] = clipRanges([highlight(1, 1000, 700, 1300)], { ...defaultClipSettings, paddingSeconds: 0, maxLengthSeconds: 120 });
  assert.equal(clip.end - clip.start, 120);
  assert.ok(clip.start < 1000 && clip.end > 1000, "Peak liegt im Clip");
  assert.equal(clip.start, 910); // 75 % vor dem Peak
});

test("feste Länge beginnt den Vorlauf vor dem Peak, am VOD-Anfang bleibt die Länge erhalten", () => {
  const s = { ...defaultClipSettings, mode: "fixed" as const, lengthSeconds: 60, leadSeconds: 40 };
  assert.deepEqual(clipRanges([highlight(1, 1000, 955, 1015)], s), [{ rank: 1, start: 960, end: 1020 }]);
  assert.deepEqual(clipRanges([highlight(1, 10, 0, 25)], s), [{ rank: 1, start: 0, end: 60 }]);
});

test("Clips enden spätestens mit dem VOD, zu kurze Reste fallen weg", () => {
  const s = { ...defaultClipSettings, mode: "fixed" as const, lengthSeconds: 60, leadSeconds: 10 };
  assert.deepEqual(clipRanges([highlight(1, 7980, 7950, 8000)], s, 8000), [{ rank: 1, start: 7970, end: 8000 }]);
  assert.deepEqual(clipRanges([highlight(1, 7999, 7950, 8000)], { ...s, leadSeconds: 0 }, 8000), []);
});

test("Dateiname aus Rang und Startzeit", () => {
  assert.equal(clipFileName({ rank: 3, start: 3725, end: 3785 }), "03_1-02-05.mp4");
});

test("mehrere Webhooks, ungültige fallen weg, alte settings.json mit einer webhookUrl geht weiter", () => {
  const s = normalizeAutomation({
    discord: {
      enabled: true,
      webhooks: [{ name: " Mods ", url: WEBHOOK }, { name: "kaputt", url: "https://example.com" }, { name: "leer", url: "" }, { url: `${WEBHOOK}2` }],
      message: "   ",
    },
  });
  assert.deepEqual(s.discord.webhooks, [{ name: "Mods", url: WEBHOOK }, { name: "", url: `${WEBHOOK}2` }]);
  assert.equal(s.discord.message, DEFAULT_MESSAGE, "leerer Text → Standardtext");
  assert.deepEqual(normalizeAutomation({ discord: { webhookUrl: WEBHOOK } }).discord.webhooks, [{ name: "", url: WEBHOOK }]);
});

test("Einstellungen werden begrenzt und ohne gültigen Webhook nicht automatisch gepostet", () => {
  const s = normalizeAutomation({
    discord: { enabled: true, webhooks: [{ url: "https://example.com/hook" }], top: 99 },
    clips: { enabled: true, mode: "fixed", count: 0, lengthSeconds: 30, leadSeconds: 45, quality: "4k", dir: "  /srv/clips " },
  });
  assert.equal(s.discord.enabled, false);
  assert.equal(s.discord.top, 25);
  assert.equal(s.clips.count, 1);
  assert.equal(s.clips.leadSeconds, 30, "Vorlauf höchstens so lang wie der Clip");
  assert.equal(s.clips.quality, "1080p", "unbekannte Qualität → Standard");
  assert.equal(normalizeAutomation({ clips: { quality: "" } }).clips.quality, "", "leer = beste bleibt erlaubt");
  assert.equal(s.clips.dir, "/srv/clips");
  assert.equal(normalizeAutomation({ discord: { enabled: true, webhookUrl: WEBHOOK } }).discord.enabled, true);
  assert.deepEqual(normalizeAutomation().clips, defaultClipSettings);
});

test("nur echte Discord-Webhooks werden akzeptiert", () => {
  assert.ok(isWebhookUrl(WEBHOOK));
  assert.ok(isWebhookUrl("https://canary.discord.com/api/webhooks/1/x"));
  assert.ok(!isWebhookUrl("http://discord.com/api/webhooks/1/x"));
  assert.ok(!isWebhookUrl("https://discord.com.evil.example/api/webhooks/1/x"));
});

test("Discord-Post: beste Highlights mit Links, ohne Pings und Formatierung aus dem Chat", () => {
  const msg = highlightsMessage(
    report([
      highlight(2, 1000, 955, 1015, { topWords: ["@everyone", "**fett**"] }),
      highlight(1, 500, 455, 515, { source: "marker", markers: ["Boss_besiegt"] }),
      highlight(3, 2000, 1955, 2015),
    ]),
    2,
  );
  const embed: any = msg.embeds![0];
  assert.deepEqual(msg.allowed_mentions, { parse: [] });
  assert.match(msg.content, /die besten 2 von 3/);
  const lines = embed.description.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\*\*#1\*\* \[7:35\]\(https:\/\/www\.twitch\.tv\/videos\/2912392719\?t=0h07m35s\)/);
  assert.match(lines[0], /★ Marker: Boss\\_besiegt/);
  assert.match(lines[1], /\\\*\\\*fett\\\*\\\*/);
  assert.equal(embed.url, "https://www.twitch.tv/videos/2912392719");
  assert.equal(embed.fields[0].name, "Subs, Raids & Bits");
  assert.equal(escapeMarkdown("a|b`c"), "a\\|b\\`c");
});

test("eigener Text mit Platzhaltern, unbekannte bleiben stehen", () => {
  const r = report([highlight(1, 500, 455, 515), highlight(2, 1000, 955, 1015)]);
  r.video.channel = "scuse_tv";
  const msg = highlightsMessage(r, 1, "{KANAL} hat {anzahl}/{gesamt} Highlights: {link} {unbekannt}");
  assert.equal(msg.content, "scuse\\_tv hat 1/2 Highlights: https://www.twitch.tv/videos/2912392719 {unbekannt}");
  assert.equal(renderMessage("x".repeat(3000), {}).length, 2000, "Discord erlaubt höchstens 2000 Zeichen");
  assert.match(testMessage("Hallo {kanal}").content, /Hallo scuse$/);
});

test("an mehrere Webhooks: ein Fehler hält die anderen nicht auf", async () => {
  const hooks = [{ name: "Mods", url: WEBHOOK }, { name: "", url: `${WEBHOOK}x` }];
  const results = await postToAll(hooks, { username: "x", content: "y", allowed_mentions: { parse: [] } }, (async (url: string) =>
    new Response(null, { status: url.endsWith("x") ? 404 : 204 })) as typeof fetch);
  assert.deepEqual(results[0], { name: "Mods" });
  assert.equal(results[1].name, "Webhook 2");
  assert.match(results[1].error!, /kennt diesen Webhook nicht/);
});

test("Discord: Rate-Limit wird einmal abgewartet, die URL steht nie im Fehler", async () => {
  const calls: number[] = [];
  const responses = [
    new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 }),
    new Response(null, { status: 204 }),
  ];
  await postToDiscord(WEBHOOK, { username: "x", content: "y", allowed_mentions: { parse: [] } }, (async () => {
    calls.push(Date.now());
    return responses.shift()!;
  }) as typeof fetch);
  assert.equal(calls.length, 2);

  await assert.rejects(
    postToDiscord(WEBHOOK, { username: "x", content: "y", allowed_mentions: { parse: [] } }, (async () => new Response("{}", { status: 404 })) as typeof fetch),
    (err: Error) => /kennt diesen Webhook nicht/.test(err.message) && !err.message.includes("abc-DEF"),
  );
  await assert.rejects(postToDiscord("https://example.com/x", { username: "x", content: "y", allowed_mentions: { parse: [] } }), /keine gültige/);
});
