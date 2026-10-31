import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAutomation, sendClips, shrinkNote } from "../src/automation.ts";
import { shrinkPlan } from "../src/clips.ts";
import { type DiscordFile, postToDiscord, TooLargeError, webhooksFor } from "../src/discord.ts";
import type { ClipFile, Report } from "../src/pipeline.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abc-DEF_42";
const MSG = { username: "x", content: "y", allowed_mentions: { parse: [] } };

const report: Report = {
  video: { id: "2912392719", title: "Dienstagsmodus", channel: "scuse", length: 8000 },
  analyzedAt: "2026-10-30T20:00:00.000Z",
  messageCount: 0,
  highlights: [],
  markers: [],
  events: { summary: { subs: 0, giftedSubs: 0, raids: 0, bits: 0 }, list: [], minimums: { giftedSubs: 5, raidViewers: 10, bits: 500 } },
};

test("Zweck pro Webhook: Highlights und Clips können in verschiedene Kanäle", () => {
  const s = normalizeAutomation({
    discord: {
      enabled: true,
      uploadClips: true,
      uploadLimitMb: 50,
      webhooks: [{ name: "Highlights", url: WEBHOOK, purpose: "highlights" }, { name: "Clips", url: `${WEBHOOK}2`, purpose: "clips" }, { url: `${WEBHOOK}3`, purpose: "quatsch" }],
    },
  });
  assert.deepEqual(webhooksFor(s.discord.webhooks, "highlights").map((w) => w.name), ["Highlights", ""]);
  assert.deepEqual(webhooksFor(s.discord.webhooks, "clips").map((w) => w.name), ["Clips", ""]);
  assert.equal(s.discord.webhooks[2].purpose, "all", "unbekannter Zweck → beides");
  assert.equal(s.discord.uploadLimitMb, 50);
  assert.equal(normalizeAutomation({ discord: { uploadLimitMb: 25 } }).discord.uploadLimitMb, 0, "unbekannte Grenze → automatisch");

  const onlyHighlights = normalizeAutomation({ discord: { uploadClips: true, webhooks: [{ url: WEBHOOK, purpose: "highlights" }] } });
  assert.equal(onlyHighlights.discord.uploadClips, false, "ohne Clip-Webhook kein Upload");
  const onlyClips = normalizeAutomation({ discord: { enabled: true, webhooks: [{ url: WEBHOOK, purpose: "clips" }] } });
  assert.equal(onlyClips.discord.enabled, false, "ohne Highlight-Webhook kein automatischer Post");
});

test("Upload als multipart mit payload_json, 413 wird als „zu groß“ erkannt", async () => {
  let form: FormData | undefined;
  const file: DiscordFile = { name: "01_1-02-05.mp4", data: new Uint8Array([1, 2, 3]) };
  await postToDiscord(WEBHOOK, MSG, (async (_url: string, init: RequestInit) => {
    form = init.body as FormData;
    return new Response(null, { status: 200 });
  }) as typeof fetch, [file]);
  assert.deepEqual(JSON.parse(String(form!.get("payload_json"))).attachments, [{ id: 0, filename: "01_1-02-05.mp4" }]);
  assert.equal((form!.get("files[0]") as File).size, 3);

  await assert.rejects(
    postToDiscord(WEBHOOK, MSG, (async () => new Response("", { status: 413 })) as typeof fetch, [file]),
    (err: Error) => err instanceof TooLargeError,
  );
});

test("Verkleinern: Auflösung passend zur Bitrate, zu lange Clips gehen nicht", () => {
  assert.deepEqual(shrinkPlan(60, 50), { height: 1080, videoKbps: 5904 });
  assert.equal(shrinkPlan(60, 10)!.height, 720);
  assert.equal(shrinkPlan(180, 10)!.height, 360);
  assert.equal(shrinkPlan(900, 10), undefined);
});

test("Automatik: lehnt Discord ab, wird für die nächste Grenze verkleinert und das gemerkt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clips-"));
  const clips: ClipFile[] = [];
  for (const rank of [2, 1]) {
    const file = join(dir, `0${rank}.mp4`);
    await writeFile(file, "");
    await truncate(file, 12e6); // größer als 10 MB, kleiner als 50
    clips.push({ rank, start: rank * 100, end: rank * 100 + 60, file });
  }
  const s = normalizeAutomation({ discord: { webhooks: [{ name: "Clips", url: WEBHOOK, purpose: "clips" }, { url: `${WEBHOOK}2`, purpose: "highlights" }] } }).discord;

  const posts: string[] = [];
  const fits: string[] = [];
  const post = (async (_url: string, payload: { content: string }, _f: unknown, files: DiscordFile[]) => {
    // Server ohne Boost: alles über 10 MB lehnt er ab
    if (files[0].data.length > 10e6) throw new TooLargeError("zu groß");
    posts.push(`${files[0].name}: ${payload.content.split("\n").at(-1)}`);
  }) as typeof postToDiscord;
  const fit = async (_ffmpeg: string, clip: ClipFile, limit: number) => {
    fits.push(`${clip.rank}@${limit}`);
    const out = clip.file.replace(/\.mp4$/, `_${limit}mb.mp4`);
    await writeFile(out, "klein");
    return out;
  };
  const notes: string[] = [];
  const sent = await sendClips(report, clips, s, () => {}, (line) => notes.push(line), { post, fit, ffmpeg: async () => "ffmpeg" });
  assert.deepEqual(sent, ["Clips"], "nur an den Clip-Webhook");
  assert.deepEqual(fits, ["1@10", "2@10"], "50 MB wird übersprungen (Datei passt schon), danach gleich 10 MB");
  assert.equal(posts.length, 2);
  assert.match(posts[0], /^01_10mb\.mp4: \*\*#1\*\* \[1:40\]\(<https:\/\/www\.twitch\.tv\/videos\/2912392719\?t=0h01m40s>\)/, "Link ohne Twitch-Vorschau");
  assert.match(posts[0], /für Discord verkleinert/);
  assert.equal(notes.length, 1, "ein Hinweis pro Webhook, nicht pro Clip");
  assert.match(notes[0], /^Clips: Discord hat die volle Qualität abgelehnt, .*nur 10 MB .*\(Server ohne Boost\)\. 2 Clips wurden deshalb verkleinert\. .*Upload-Grenze/);
});

test("Hinweis bei fest eingestellter Grenze nennt, wo man sie ändert", () => {
  assert.match(shrinkNote("Clips", 1, 50, false), /1 Clip wurde verkleinert, weil .*50 MB \(Boost-Stufe 2\).*„Automatisch“/);
});
