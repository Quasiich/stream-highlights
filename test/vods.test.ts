import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVods, parseDuration, parseVods } from "../src/twitch.ts";

/** Gekürzte Antwort von GET /helix/videos */
const page = (ids: string[], cursor?: string) => ({
  data: ids.map((id, i) => ({
    id,
    user_id: "42",
    title: `Stream ${id}`,
    created_at: `2026-10-${String(20 - i).padStart(2, "0")}T18:00:00Z`,
    duration: "3h2m1s",
    view_count: 120,
    thumbnail_url: `https://static-cdn.jtvnw.net/cf_vods/abc/${id}/thumb/thumb0-%{width}x%{height}.jpg`,
    type: "archive",
  })),
  pagination: cursor ? { cursor } : {},
});

test("parseDuration", () => {
  assert.equal(parseDuration("3h2m1s"), 10921);
  assert.equal(parseDuration("45m"), 2700);
  assert.equal(parseDuration("59s"), 59);
  assert.equal(parseDuration("kaputt"), 0);
});

test("parseVods liest VODs, Vorschaubild und Cursor", () => {
  const { vods, cursor } = parseVods(page(["111", "222"], "abc"));
  assert.equal(cursor, "abc");
  assert.deepEqual(vods[0], {
    id: "111",
    title: "Stream 111",
    createdAt: "2026-10-20T18:00:00Z",
    length: 10921,
    views: 120,
    thumbnail: "https://static-cdn.jtvnw.net/cf_vods/abc/111/thumb/thumb0-320x180.jpg",
  });
  assert.equal(parseVods(page(["1"])).cursor, undefined, "letzte Seite hat keinen Cursor");
});

test("parseVods lässt Twitchs Platzhalterbild weg", () => {
  const body = page(["1"]);
  body.data[0].thumbnail_url = "https://vod-secure.twitch.tv/_404/404_processing_%{width}x%{height}.png";
  assert.equal(parseVods(body).vods[0].thumbnail, "");
});

test("fetchVods fragt die eigenen Archiv-VODs mit Cursor ab und erneuert abgelaufene Tokens", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vods-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ clientId: "cid", accessToken: "alt", refreshToken: "r1", login: "streamer", userId: "42" }));

  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = String(input);
    if (url.startsWith("https://id.twitch.tv/oauth2/token")) {
      return Response.json({ access_token: "neu", refresh_token: "r2" });
    }
    requests.push(`${url} ${init.headers?.Authorization}`);
    if (init.headers?.Authorization === "Bearer alt") return new Response("{}", { status: 401 });
    const after = new URL(url).searchParams.get("after");
    return Response.json(after ? page(["666", "777", "888"]) : page(["111", "222", "333", "444", "555"], "c1"));
  });

  const first = await fetchVods(5, undefined, authPath);
  assert.deepEqual(first.vods.map((v) => v.id), ["111", "222", "333", "444", "555"]);
  assert.equal(first.cursor, "c1");
  const url = new URL(requests.at(-1)!.split(" ")[0]);
  assert.equal(url.origin + url.pathname, "https://api.twitch.tv/helix/videos");
  assert.equal(url.searchParams.get("user_id"), "42");
  assert.equal(url.searchParams.get("type"), "archive");
  assert.equal(url.searchParams.get("first"), "5");
  assert.ok(requests.at(-1)!.endsWith("Bearer neu"), "nach 401 mit erneuertem Token wiederholt");
  assert.equal(JSON.parse(await readFile(authPath, "utf8")).refreshToken, "r2", "neues Token gespeichert");

  const more = await fetchVods(3, first.cursor, authPath);
  assert.deepEqual(more.vods.map((v) => v.id), ["666", "777", "888"]);
  assert.equal(more.cursor, undefined);
  const moreUrl = new URL(requests.at(-1)!.split(" ")[0]);
  assert.equal(moreUrl.searchParams.get("after"), "c1");
  assert.equal(moreUrl.searchParams.get("first"), "3");
});
