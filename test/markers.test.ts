import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTwitchDownloader } from "../src/chat.ts";
import { defaultOptions, findHighlights } from "../src/analyze.ts";
import { fetchMarkers, parseMarkers } from "../src/twitch.ts";

/** Ruhiger 2-Stunden-Chat mit einem einzigen Chat-Peak bei 0:30:00. */
function chat() {
  const comments: any[] = [];
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const add = (t: number, user: string, body: string) =>
    comments.push({ content_offset_seconds: t, commenter: { name: user }, message: { body, fragments: [{ text: body, emoticon: null }] } });
  for (let t = 0; t < 7200; t += 4 + rand() * 8) add(t, `user${Math.floor(rand() * 30)}`, "hallo wie gehts");
  for (let i = 0; i < 60; i++) add(1800 + rand() * 25, `fan${i}`, "KEKW KEKW");
  return parseTwitchDownloader({ video: { id: "123456789", length: 7200 }, comments });
}

test("Marker werden Highlights, stehen vorne und bekommen 60 s Vorlauf", () => {
  const hl = findHighlights(chat(), { ...defaultOptions, top: 3 }, [
    { offset: 5000, description: "Boss besiegt" },
    { offset: 3000, description: "" },
  ]);
  assert.deepEqual(hl.slice(0, 2).map((h) => [h.source, h.peak, h.start, h.end]), [
    ["marker", 3000, 2940, 3030],
    ["marker", 5000, 4940, 5030],
  ]);
  assert.deepEqual(hl[0].markers, []);
  assert.deepEqual(hl[1].markers, ["Boss besiegt"]);
  assert.ok(hl.slice(2).every((h) => h.source !== "marker"));
});

test("Marker und Chat-Peak zur selben Zeit werden ein Clip", () => {
  const hl = findHighlights(chat(), { ...defaultOptions, top: 3 }, [{ offset: 1840, description: "Fail" }]);
  const merged = hl.filter((h) => h.start <= 1800 && h.end >= 1840);
  assert.equal(merged.length, 1, JSON.stringify(hl.map((h) => [h.source, h.start, h.end])));
  assert.equal(merged[0].source, "marker+chat");
  assert.equal(merged[0].peak, 1840, "Zeitpunkt des Markers bleibt");
  assert.ok(merged[0].score > 3, "Chat-Ausschlag wird übernommen");
  assert.equal(hl[0], merged[0], "steht ganz vorne");
});

test("--top begrenzt nur die Chat-Highlights, Marker kommen dazu", () => {
  const markers = [1000, 2500, 4000, 6000].map((offset) => ({ offset, description: "" }));
  const hl = findHighlights(chat(), { ...defaultOptions, top: 1 }, markers);
  assert.equal(hl.filter((h) => h.source === "marker").length, 4);
  assert.equal(hl.filter((h) => h.source !== "marker").length, 1);
});

test("parseMarkers liest die Antwort von GET /helix/streams/markers", () => {
  const body = {
    data: [
      {
        user_id: "1",
        videos: [
          {
            video_id: "123456789",
            markers: [
              { id: "a", created_at: "2026-10-01T20:00:00Z", description: " Clutch ", position_seconds: 754, URL: "" },
              { id: "b", created_at: "2026-10-01T20:05:00Z", description: "", position_seconds: 1054, URL: "" },
            ],
          },
        ],
      },
    ],
    pagination: {},
  };
  assert.deepEqual(parseMarkers(body), [
    { offset: 754, description: "Clutch" },
    { offset: 1054, description: "" },
  ]);
  assert.deepEqual(parseMarkers({}), []);
});

test("fetchMarkers erneuert ein abgelaufenes Token und lädt alle Seiten", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "markers-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ clientId: "cid", accessToken: "alt", refreshToken: "r1", login: "streamer" }));

  const calls: string[] = [];
  const page = (offsets: number[], cursor?: string) =>
    Response.json({ data: [{ videos: [{ markers: offsets.map((o) => ({ position_seconds: o, description: "" })) }] }], pagination: cursor ? { cursor } : {} });
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url.includes("oauth2/token") ? `token ${init.body.get("grant_type")} ${init.body.get("refresh_token")}` : `${init.headers.Authorization} ${new URL(url).searchParams.get("after") ?? "-"}`);
    if (url.includes("oauth2/token")) return Response.json({ access_token: "neu", refresh_token: "r2" });
    if (init.headers.Authorization === "Bearer alt") return Response.json({ message: "Invalid OAuth token" }, { status: 401 });
    return new URL(url).searchParams.get("after") ? page([100]) : page([900, 300], "seite2");
  });

  const markers = await fetchMarkers("123456789", authPath);
  assert.deepEqual(markers.map((m) => m.offset), [100, 300, 900]);
  assert.deepEqual(calls, ["Bearer alt -", "token refresh_token r1", "Bearer neu -", "Bearer neu seite2"]);
  const saved = JSON.parse(await readFile(authPath, "utf8"));
  assert.equal(saved.accessToken, "neu");
  assert.equal(saved.refreshToken, "r2", "neues Refresh-Token gespeichert (alte sind nur einmal gültig)");
});

test("fetchMarkers meldet fremde VODs verständlich", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "markers-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ clientId: "cid", accessToken: "a", refreshToken: "r", login: "streamer" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "user is not authorized" }, { status: 403 }));
  await assert.rejects(fetchMarkers("999", authPath), /403.*angemeldeten Kanals \(streamer\)/);
});
