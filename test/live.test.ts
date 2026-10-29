import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOptions } from "../src/analyze.ts";
import { loadChat } from "../src/chat.ts";
import { connectEventSub, type SocketLike } from "../src/eventsub.ts";
import { startLive } from "../src/livemode.ts";
import type { AnalysisResult } from "../src/pipeline.ts";
import { type CaptureMeta, fromChatMessage, fromNotification, LiveRecorder, type RecorderOptions } from "../src/recorder.ts";

const chat = (text: string, extra: any = {}) => ({
  broadcaster_user_id: "42",
  chatter_user_login: "zuschauer",
  chatter_user_name: "Zuschauer",
  message: { text, fragments: [{ type: "text", text }] },
  ...extra,
});

test("fromChatMessage übernimmt Emotes und Bits und lässt fremde Kanäle im Shared Chat weg", () => {
  const msg = fromChatMessage(
    chat("KEKW gut", { message: { text: "KEKW gut", fragments: [{ type: "emote", text: "KEKW" }, { type: "text", text: " gut" }] } }),
    12.5,
  );
  assert.deepEqual(msg, { offset: 12.5, user: "zuschauer", text: "KEKW gut", emotes: ["KEKW"] });
  assert.deepEqual(fromChatMessage(chat("Cheer500", { cheer: { bits: 500 } }), 1), {
    offset: 1,
    user: "zuschauer",
    text: "Cheer500",
    emotes: [],
    event: "bits",
    amount: 500,
  });
  assert.equal(fromChatMessage(chat("hi", { source_broadcaster_user_id: "77" }), 1), undefined);
  assert.ok(fromChatMessage(chat("hi", { source_broadcaster_user_id: "42" }), 1));
});

test("fromNotification bildet Subs, Gift-Bomben und Raids wie beim Chat-Download ab", () => {
  const n = (notice_type: string, extra: any = {}) => ({ ...chat(""), system_message: "System", notice_type, ...extra });
  assert.equal(fromNotification(n("sub"), 5)?.event, "sub");
  assert.deepEqual(
    fromNotification(n("resub", { resub: { cumulative_months: 8 }, message: { text: "Danke!", fragments: [] } }), 5),
    { offset: 5, user: "zuschauer", text: "System Danke!", emotes: [], event: "resub", amount: 8 },
  );
  assert.equal(fromNotification(n("community_sub_gift", { community_sub_gift: { total: 20 } }), 5)?.amount, 20);
  assert.equal(fromNotification(n("sub_gift", { sub_gift: { community_gift_id: "x" } }), 5), undefined, "Teil einer Gift-Bombe");
  assert.equal(fromNotification(n("sub_gift", { sub_gift: {} }), 5)?.event, "subgift");
  assert.equal(fromNotification(n("raid", { raid: { viewer_count: 37 } }), 5)?.amount, 37);
  assert.equal(fromNotification(n("community_sub_gift", { chatter_is_anonymous: true, community_sub_gift: { total: 5 } }), 5)?.user, "anonymous");
  assert.equal(fromNotification(n("announcement"), 5), undefined);
  assert.equal(fromNotification(n("shared_chat_sub", { source_broadcaster_user_id: "77" }), 5), undefined);
});

class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closed = false;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  send(message_type: string, payload: any = {}, message_id?: string) {
    this.onmessage?.({ data: JSON.stringify({ metadata: { message_type, message_id, message_timestamp: "2026-10-29T20:00:00Z", subscription_type: payload.subscription?.type }, payload }) });
  }
  welcome(id: string) {
    this.send("session_welcome", { session: { id, keepalive_timeout_seconds: 10 } });
  }
}

test("EventSub: abonniert pro Sitzung, filtert Duplikate, zieht bei session_reconnect ohne neues Abo um und verbindet nach Abbruch neu", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  FakeSocket.all = [];
  const sessions: string[] = [];
  const events: string[] = [];
  const disconnects: string[] = [];
  const conn = connectEventSub(
    {
      onSession: async (id) => void sessions.push(id),
      onEvent: (type, event) => events.push(`${type}:${event.n}`),
      onDisconnect: (reason) => disconnects.push(reason),
      onRevocation: () => {},
    },
    "wss://test",
    (url) => new FakeSocket(url),
  );

  const [first] = FakeSocket.all;
  first.welcome("s1");
  assert.deepEqual(sessions, ["s1"]);
  const note = (n: number) => ({ subscription: { type: "channel.chat.message" }, event: { n } });
  first.send("notification", note(1), "m1");
  first.send("notification", note(1), "m1");
  assert.deepEqual(events, ["channel.chat.message:1"], "Duplikat verworfen");

  first.send("session_reconnect", { session: { reconnect_url: "wss://neu" } }, "m2");
  const second = FakeSocket.all[1];
  assert.equal(second.url, "wss://neu");
  first.send("notification", note(2), "m3");
  second.welcome("s2");
  assert.ok(first.closed, "alte Verbindung erst nach Welcome der neuen geschlossen");
  assert.deepEqual(sessions, ["s1"], "Abos ziehen mit um");
  second.send("notification", note(3), "m4");
  assert.deepEqual(events, ["channel.chat.message:1", "channel.chat.message:2", "channel.chat.message:3"]);

  second.onclose?.({ code: 1006, reason: "" });
  assert.equal(disconnects.length, 1);
  t.mock.timers.tick(1000);
  const third = FakeSocket.all[2];
  assert.equal(third.url, "wss://test");
  third.welcome("s3");
  await Promise.resolve();
  assert.deepEqual(sessions, ["s1", "s3"], "neue Sitzung, neu abonniert");

  // Kein Keepalive mehr → neu verbinden
  t.mock.timers.tick(21_000);
  assert.equal(disconnects.length, 2);
  assert.ok(third.closed);
  conn.close();
});

async function setup(t: any, vods: any[] = [{ id: "555", stream_id: "900", title: "Mein Stream", duration: "1h0m0s" }]) {
  const dir = await mkdtemp(join(tmpdir(), "live-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, JSON.stringify({ clientId: "cid", accessToken: "a", refreshToken: "r", login: "streamer", userId: "42" }));
  let live: any;
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === "/helix/streams") return Response.json({ data: live ? [live] : [] });
    if (url.pathname === "/helix/videos") return Response.json({ data: vods, pagination: {} });
    return new Response("{}", { status: 404 });
  });
  let finished!: (r: AnalysisResult) => void;
  const done = new Promise<AnalysisResult>((resolve) => (finished = resolve));
  const lines: string[] = [];
  const opts: RecorderOptions = {
    outDir: join(dir, "output"),
    authPath,
    graceMs: 0,
    analyze: defaultOptions,
    maxGapSeconds: 120,
    vodAttempts: 1,
    vodRetryMs: 0,
    log: (line) => lines.push(line),
    onFinished: finished,
  };
  return { dir, opts, done, lines, setLive: (s: any) => (live = s) };
}

const at = (seconds: number) => new Date(Date.parse("2026-10-29T18:00:00Z") + seconds * 1000).toISOString();

test("LiveRecorder schneidet einen Stream mit und wertet ihn nach stream.offline aus", async (t) => {
  const { opts, done } = await setup(t);
  const rec = new LiveRecorder("42", "streamer", opts, () => Date.parse(at(5)));

  await rec.handle("stream.online", { broadcaster_user_id: "42", id: "900", type: "live", started_at: at(0) }, at(1));
  await rec.handle("channel.chat.message", chat("hallo"), at(10));
  await rec.handle("channel.chat.message", { ...chat("fremder Kanal"), broadcaster_user_id: "77" }, at(11));
  await rec.handle("channel.chat.notification", { ...chat(""), notice_type: "raid", raid: { viewer_count: 50 } }, at(20));
  await rec.handle("stream.offline", { broadcaster_user_id: "42" }, at(3600));
  await rec.handle("channel.chat.message", chat("nach dem Stream"), at(3700));

  const result = await done;
  assert.equal(result.dir, join(opts.outDir, "555"));
  const log = await loadChat(join(result.dir, "chat.json"));
  assert.equal(log.videoId, "555");
  assert.equal(log.title, "Mein Stream");
  assert.equal(log.length, 3600);
  assert.deepEqual(log.messages.map((m) => [m.offset, m.text, m.event]), [
    [10, "hallo", undefined],
    [20, "", "raid"],
  ]);
  assert.equal(result.report.events.list[0].amount, 50);
  assert.ok(existsSync(join(result.dir, "highlights.json")));
  assert.deepEqual(await readdir(join(opts.outDir, "live")), [], "Mitschnitt aufgeräumt");
});

test("LiveRecorder setzt nach einem Neustart fort und merkt sich die Lücke", async (t) => {
  const { opts, setLive } = await setup(t);
  setLive({ id: "900", started_at: at(0), title: "x" });
  const first = new LiveRecorder("42", "streamer", opts, () => Date.parse(at(30)));
  await first.sync();
  await first.handle("channel.chat.message", chat("eins"), at(40));
  await first.stop();

  const second = new LiveRecorder("42", "streamer", { ...opts, graceMs: 60_000 }, () => Date.parse(at(600)));
  await second.sync();
  await second.handle("channel.chat.message", chat("zwei"), at(610));
  const meta: CaptureMeta = JSON.parse(await readFile(join(opts.outDir, "live", "900.json"), "utf8"));
  assert.deepEqual(meta.gaps, [{ from: 40, to: 600 }]);
  await second.stop();
  const lines = (await readFile(join(opts.outDir, "live", "900.jsonl"), "utf8")).trim().split("\n");
  assert.deepEqual(lines.map((l) => JSON.parse(l).text), ["eins", "zwei"]);
});

test("LiveRecorder vermerkt verspäteten Start und wertet liegen gebliebene Mitschnitte aus", async (t) => {
  const { opts, done, setLive } = await setup(t, [{ id: "555", stream_id: "900", title: "Alt", duration: "10m" }]);
  setLive({ id: "901", started_at: at(0), title: "neu" });
  const rec = new LiveRecorder("42", "streamer", { ...opts, maxGapSeconds: Infinity }, () => Date.parse(at(300)));
  await mkdir(join(opts.outDir, "live"), { recursive: true });
  await writeFile(join(opts.outDir, "live", "900.json"), JSON.stringify({ streamId: "900", startedAt: at(-7200), gaps: [] }));
  await writeFile(join(opts.outDir, "live", "900.jsonl"), `${JSON.stringify({ offset: 3, user: "a", text: "alt", emotes: [] })}\n{"kaputt`);

  await rec.sync();
  const result = await done;
  assert.equal(result.report.video.id, "555");
  assert.equal(result.report.messageCount, 1, "halbe Zeile übersprungen");
  const meta: CaptureMeta = JSON.parse(await readFile(join(opts.outDir, "live", "901.json"), "utf8"));
  assert.deepEqual(meta.gaps, [{ from: 0, to: 300 }]);
  await rec.stop();
});

test("startLive abonniert die vier Ereignisse und meldet den Status, ohne Chat-Scope gibt es eine klare Fehlermeldung", async (t) => {
  const { opts } = await setup(t);
  let scopes = ["user:read:broadcast"];
  const subscriptions: any[] = [];
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/oauth2/validate") return Response.json({ user_id: "42", login: "streamer", scopes, expires_in: 9000 });
    if (url.pathname === "/helix/eventsub/subscriptions") {
      subscriptions.push(JSON.parse(init.body));
      return Response.json({ data: [] }, { status: 202 });
    }
    if (url.pathname === "/helix/streams") return Response.json({ data: [] });
    return new Response("{}", { status: 404 });
  });

  await assert.rejects(startLive({ ...opts, createSocket: (u) => new FakeSocket(u) }), /Chat noch nicht lesen/);

  scopes = ["user:read:broadcast", "user:read:chat"];
  FakeSocket.all = [];
  const service = await startLive({ ...opts, createSocket: (u) => new FakeSocket(u) });
  assert.equal(service.status().state, "connecting");
  FakeSocket.all[0].welcome("s1");
  for (let i = 0; i < 20 && service.status().state !== "waiting"; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    subscriptions.map((s) => [s.type, s.transport.session_id, s.condition.user_id]),
    [
      ["stream.online", "s1", undefined],
      ["stream.offline", "s1", undefined],
      ["channel.chat.message", "s1", "42"],
      ["channel.chat.notification", "s1", "42"],
    ],
  );
  const status = service.status();
  assert.equal(status.state, "waiting");
  assert.equal(status.connected, true);
  assert.equal(status.channel, "streamer");
  await service.stop();
});
