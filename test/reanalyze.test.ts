import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOptions } from "../src/analyze.ts";
import { analysisInput, runAutomation } from "../src/automation.ts";
import { LIVE_FORMAT } from "../src/chat.ts";
import { defaultClipSettings } from "../src/clips.ts";
import { defaultDiscordSettings } from "../src/discord.ts";
import { type Report, runAnalysis } from "../src/pipeline.ts";
import { defaultVoiceOptions } from "../src/voice.ts";

/** Kurzer Chat im TwitchDownloader-Format mit zwei Peaks */
function chat(videoId: string) {
  const comments: any[] = [];
  for (let t = 0; t < 3600; t += 6) comments.push({ content_offset_seconds: t, commenter: { name: `u${t % 11}` }, message: { body: "jo", fragments: [] } });
  for (const at of [900, 2400]) {
    for (let i = 0; i < 40; i++) comments.push({ content_offset_seconds: at + i * 0.5, commenter: { name: `f${at}_${i}` }, message: { body: "KEKW", fragments: [] } });
  }
  return { video: { id: videoId, title: "Test", length: 3600 }, streamer: { name: "scuse" }, comments };
}

// Ohne Twitch-Anmeldung im Testordner: keine Marker, kein Netz
const offline = { ...defaultOptions };

test("Neu analysieren: neue Einstellungen gelten, gepostet-Vermerk und Clips bleiben", async () => {
  const out = await mkdtemp(join(tmpdir(), "re-"));
  const dir = join(out, "123456789");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "chat.json"), JSON.stringify(chat("123456789")));

  const first = await runAnalysis(analysisInput("123456789", out), offline, () => {}, out);
  assert.equal(first.report.highlights.length, 2);
  assert.equal(first.report.options?.top, 10);

  // Wie nach dem Live-Stream: gepostet und Clips geschnitten
  const posted: Report = { ...first.report, automation: { state: "done", at: "2026-10-31T20:00:00Z" }, clips: [{ rank: 1, start: 0, end: 60, file: "/clips/1.mp4" }] };
  await writeFile(join(dir, "highlights.json"), JSON.stringify(posted));

  const again = await runAnalysis(analysisInput("123456789", out), { ...offline, top: 1 }, () => {}, out);
  assert.equal(again.report.highlights.length, 1, "neue Einstellung (top 1) gilt");
  assert.equal(again.report.options?.top, 1);
  const saved: Report = JSON.parse(await readFile(join(dir, "highlights.json"), "utf8"));
  assert.deepEqual(saved.automation, posted.automation, "gepostet-Vermerk bleibt");
  assert.deepEqual(saved.clips, posted.clips, "Clips bleiben");
});

test("runAutomation postet nicht ein zweites Mal", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "re-"));
  let posts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    posts++;
    return new Response(null, { status: 204 });
  });
  const report = {
    video: { id: "1" },
    highlights: [],
    automation: { state: "done", at: "x" },
  } as unknown as Report;
  const s = {
    mode: "auto" as const,
    discord: { ...defaultDiscordSettings, enabled: true, webhooks: [{ name: "", url: "https://discord.com/api/webhooks/1/a" }] },
    clips: { ...defaultClipSettings, enabled: false },
  };
  const lines: string[] = [];
  assert.equal(await runAutomation({ report, dir: out }, s, (l) => lines.push(l), out), "done");
  assert.equal(posts, 0);
  assert.match(lines.join(), /schon erledigt/);
});

test("Live-Mitschnitt ohne VOD: keine Sprach-Auswertung, also auch kein Zurückhalten", async () => {
  const out = await mkdtemp(join(tmpdir(), "re-"));
  const dir = join(out, "41234567890");
  await mkdir(dir, { recursive: true });
  const live = {
    format: LIVE_FORMAT,
    video: { title: "Ohne VOD", channel: "scuse", length: 1800, streamId: "41234567890", startedAt: "2026-10-31T18:00:00Z" },
    messages: [{ offset: 10, user: "a", text: "hallo", emotes: [] }],
  };
  await writeFile(join(dir, "chat.json"), JSON.stringify(live));
  const { report } = await runAnalysis(analysisInput("41234567890", out), { ...offline, voice: { ...defaultVoiceOptions, enabled: true } }, () => {}, out);
  assert.equal(report.voiceFailed, undefined, "kein Fehlschlag, nur übersprungen");
  assert.match(report.voiceNote ?? "", /kein VOD/);
});
