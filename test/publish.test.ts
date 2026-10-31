import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Highlight } from "../src/analyze.ts";
import { normalizeAutomation, publish, runAutomation } from "../src/automation.ts";
import { clipRanges, defaultClipSettings } from "../src/clips.ts";
import { highlightsMessage } from "../src/discord.ts";
import type { Report } from "../src/pipeline.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abc-DEF_42";

function highlight(rank: number): Highlight {
  const peak = rank * 1000;
  return { rank, source: "chat", sources: ["chat"], markers: [], keywords: [], peak, start: peak - 30, end: peak + 30, score: 3, messages: 40, chatters: 12, topWords: [], sample: [] };
}

function report(n = 5): Report {
  return {
    video: { id: "2912392719", title: "Dienstagsmodus", channel: "scuse", length: 8000 },
    analyzedAt: "2026-10-30T20:00:00.000Z",
    messageCount: 100,
    highlights: Array.from({ length: n }, (_, i) => highlight(i + 1)),
    markers: [],
    events: { summary: { subs: 0, giftedSubs: 0, raids: 0, bits: 0 }, list: [], minimums: { giftedSubs: 5, raidViewers: 10, bits: 500 } },
  };
}

/** Fängt die Discord-Posts ab */
function fakeDiscord() {
  const posts: { url: string; body: any }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { posts, restore: () => (globalThis.fetch = original) };
}

test("Auswahl: Zusammenfassung und Clip-Bereiche nur für die gewählten Ränge, Originalnummern bleiben", () => {
  const r = report();
  const lines = (highlightsMessage(r, 5, undefined, [4, 2]).embeds![0] as any).description.split("\n");
  assert.deepEqual(lines.map((l: string) => l.match(/^\*\*#(\d)/)![1]), ["2", "4"]);
  assert.match(highlightsMessage(r, 5, "{anzahl} von {gesamt}", [4, 2]).content, /^2 von 5$/);
  assert.deepEqual(clipRanges(r.highlights, { ...defaultClipSettings, count: 1 }, 8000, [3, 5]).map((c) => c.rank), [3, 5], "Auswahl statt Anzahl");
});

test("Modus manuell: nach der Live-Auswertung wird nichts gepostet, nur vermerkt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const discord = fakeDiscord();
  const lines: string[] = [];
  try {
    const s = normalizeAutomation({ publish: { mode: "manual" }, discord: { enabled: true, webhooks: [{ url: WEBHOOK }] } });
    const r = report();
    await runAutomation({ report: r, dir }, s, (l) => lines.push(l));
    assert.equal(discord.posts.length, 0);
    assert.equal(JSON.parse(await readFile(join(dir, "highlights.json"), "utf8")).awaitingSelection, true);
    assert.match(lines[0], /5 Highlights warten auf deine Auswahl/);
  } finally {
    discord.restore();
  }
});

test("Auswahl posten: nur die gewählten, wird vermerkt, die Erinnerung ist weg", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const discord = fakeDiscord();
  try {
    const s = normalizeAutomation({ publish: { mode: "manual" }, discord: { enabled: true, webhooks: [{ url: WEBHOOK }] } });
    const r = { ...report(), awaitingSelection: true };
    const result = await publish(r, dir, { summary: [3, 1] }, s);
    assert.deepEqual(result.errors, []);
    assert.match(result.done[0], /Zusammenfassung mit 2 Highlights/);
    assert.equal(discord.posts.length, 1);
    assert.equal(discord.posts[0].body.embeds[0].description.split("\n").length, 2);

    await publish(r, dir, { summary: [2] }, s);
    const saved: Report = JSON.parse(await readFile(join(dir, "highlights.json"), "utf8"));
    assert.equal(saved.awaitingSelection, undefined);
    assert.deepEqual(saved.posted?.summary?.ranks, [1, 2, 3], "alles, was schon in Discord war");
  } finally {
    discord.restore();
  }
});

test("Automatisch: die besten n wie bisher, ohne Webhook für Highlights eine Fehlermeldung statt Absturz", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const discord = fakeDiscord();
  try {
    const s = normalizeAutomation({ discord: { enabled: true, top: 2, webhooks: [{ url: WEBHOOK }] } });
    assert.equal(s.mode, "auto");
    await runAutomation({ report: report(), dir }, s, () => {});
    assert.equal(discord.posts[0].body.embeds[0].description.split("\n").length, 2);

    const onlyClips = normalizeAutomation({ discord: { webhooks: [{ url: WEBHOOK, purpose: "clips" }] } });
    const result = await publish(report(), dir, { summary: [1] }, onlyClips);
    assert.match(result.errors[0], /Webhook für Highlights/);
  } finally {
    discord.restore();
  }
});

test("Zusammen mit dem Zurückhalten: manuell wird nie zurückgehalten, nach „Auswahl posten“ postet nichts mehr von selbst", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  const discord = fakeDiscord();
  const lines: string[] = [];
  try {
    const manual = normalizeAutomation({ publish: { mode: "manual" }, discord: { enabled: true, webhooks: [{ url: WEBHOOK }] } });
    const r: Report = { ...report(), voiceFailed: { network: true }, voiceNote: "ffmpeg blockiert", automation: { state: "held", reason: "Internet" } };
    assert.equal(await runAutomation({ report: r, dir }, manual, (l) => lines.push(l)), undefined);
    assert.equal(r.automation, undefined, "nicht mehr zurückgehalten, es wartet ja auf die Auswahl");
    assert.equal(r.awaitingSelection, true);
    assert.match(lines[0], /Sprach-Auswertung ist fehlgeschlagen/);

    await publish(r, dir, { summary: [1] }, manual);
    const saved: Report = JSON.parse(await readFile(join(dir, "highlights.json"), "utf8"));
    assert.equal(saved.automation?.state, "done");
    const auto = normalizeAutomation({ discord: { enabled: true, webhooks: [{ url: WEBHOOK }] } });
    await runAutomation({ report: r, dir }, auto, () => {});
    assert.equal(discord.posts.length, 1, "erneute Auswertung postet nicht noch einmal");
  } finally {
    discord.restore();
  }
});
