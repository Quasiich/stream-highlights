import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalyzeOptions } from "./analyze.ts";
import { type ChatMessage, LIVE_FORMAT, type LiveChatFile } from "./chat.ts";
import { type AnalysisResult, runAnalysis } from "./pipeline.ts";
import { AUTH_FILE, fetchLiveStream, findVodForStream, type LiveStream, type Vod } from "./twitch.ts";

/** Ein Abschnitt des Streams, in dem der Mitschnitt nicht verbunden war (Sekunden seit Stream-Beginn) */
export interface Gap {
  from: number;
  to: number;
}

/** output/live/<Stream-ID>.json, daneben die Nachrichten als <Stream-ID>.jsonl */
export interface CaptureMeta {
  streamId: string;
  /** Beginn des Streams (ISO) */
  startedAt: string;
  channel?: string;
  /** Ende laut stream.offline (ISO), fehlt solange live */
  endedAt?: string;
  gaps: Gap[];
}

export interface RecorderOptions {
  /** Ausgabeordner wie bei der Analyse, der Mitschnitt liegt in <outDir>/live/ */
  outDir: string;
  authPath: string;
  /** So lange nach stream.offline warten, falls der Stream nur kurz abgebrochen ist */
  graceMs: number;
  analyze: AnalyzeOptions;
  /**
   * Fehlen insgesamt mehr Sekunden als das (Programm lief nicht oder war
   * getrennt), wird der Chat vollständig per TwitchDownloaderCLI geladen.
   * Infinity schaltet das ab.
   */
  maxGapSeconds: number;
  /** Wie oft und in welchem Abstand nach dem VOD gesucht wird, Twitch braucht manchmal etwas */
  vodAttempts: number;
  vodRetryMs: number;
  log: (line: string) => void;
  /** Wird nach jeder fertigen Analyse aufgerufen (Discord, Clips), mit dem Protokoll des Mitschnitts */
  onFinished?: (result: AnalysisResult, log: (line: string) => void) => void | Promise<void>;
}

/** Sekunden zwischen zwei Zeitpunkten (ISO bzw. ms) */
const secondsBetween = (from: string, to: string | number) =>
  Math.max(0, Math.round(((typeof to === "number" ? to : Date.parse(to)) - Date.parse(from)) / 100) / 10);

/** Ab so viel Verspätung beim Start fehlt der Anfang des Chats */
const LATE_START_SECONDS = 60;

/**
 * channel.chat.message → ChatMessage. Nachrichten aus anderen Kanälen eines
 * geteilten Chats (Shared Chat) gehören nicht zum eigenen VOD.
 */
export function fromChatMessage(e: any, offset: number): ChatMessage | undefined {
  if (!e || (e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id)) return undefined;
  const fragments: any[] = e.message?.fragments ?? [];
  const bits = Number(e.cheer?.bits) || 0;
  return {
    offset,
    user: String(e.chatter_user_login ?? e.chatter_user_name ?? "?"),
    text: String(e.message?.text ?? ""),
    emotes: fragments.filter((f) => f.type === "emote").map((f) => String(f.text).trim()),
    ...(bits > 0 ? { event: "bits", amount: bits } : {}),
  };
}

/**
 * channel.chat.notification → Sub/Raid im selben Format wie beim Chat-Download.
 * Die einzelnen Geschenke einer Gift-Bombe tragen eine community_gift_id und
 * fallen weg, die Bombe selbst zählt mit ihrer Gesamtzahl.
 */
export function fromNotification(e: any, offset: number): ChatMessage | undefined {
  if (!e || (e.source_broadcaster_user_id && e.source_broadcaster_user_id !== e.broadcaster_user_id)) return undefined;
  let event: string;
  let amount: number | undefined;
  switch (e.notice_type) {
    case "sub":
      event = "sub";
      break;
    case "resub":
      event = "resub";
      amount = Number(e.resub?.cumulative_months) || undefined;
      break;
    case "sub_gift":
      if (e.sub_gift?.community_gift_id) return undefined;
      event = "subgift";
      break;
    case "community_sub_gift":
      event = "submysterygift";
      amount = Number(e.community_sub_gift?.total) || undefined;
      break;
    case "raid":
      event = "raid";
      amount = Number(e.raid?.viewer_count) || undefined;
      break;
    default:
      return undefined;
  }
  const user = e.chatter_is_anonymous ? "anonymous" : String(e.chatter_user_login ?? e.chatter_user_name ?? "?");
  const text = [e.system_message, e.message?.text].filter(Boolean).join(" ");
  return { offset, user, text, emotes: [], event, ...(amount !== undefined ? { amount } : {}) };
}

/** Was der Mitschnitt gerade tut, für die Oberfläche */
export interface RecorderStatus {
  /** waiting: kein Stream, recording: schneidet mit, ending: offline, Wartezeit läuft, analyzing: wertet aus */
  state: "waiting" | "recording" | "ending" | "analyzing";
  stream?: { id: string; startedAt: string; messages: number };
  /** Wann die Auswertung startet (ISO), solange state "ending" ist */
  analyzeAt?: string;
}

interface Capture {
  meta: CaptureMeta;
  out: WriteStream;
  /** Bisher mitgeschriebene Nachrichten */
  messages: number;
  /** Nach stream.offline: keine Nachrichten mehr, Auswertung nach Ablauf von `timer` */
  timer?: ReturnType<typeof setTimeout>;
  /** Wann `timer` abläuft (ms) */
  analyzeAt?: number;
  /** Seit wann (Sekunden) die Verbindung fehlt */
  gapFrom?: number;
}

/**
 * Schreibt den Chat eines laufenden Streams mit und wertet ihn nach dem
 * Stream-Ende aus. Der Mitschnitt landet laufend auf der Platte, sodass ein
 * Neustart des Programms mitten im Stream nur eine Lücke hinterlässt.
 */
export class LiveRecorder {
  private current?: Capture;
  private finalizing = new Set<string>();
  /** Zustandswechsel nacheinander, damit z. B. stream.online und sync() nicht doppelt anlegen */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly liveDir: string;
  private readonly now: () => number;

  constructor(
    private readonly userId: string,
    private readonly channel: string | undefined,
    private readonly opts: RecorderOptions,
    now: () => number = Date.now,
  ) {
    this.liveDir = join(opts.outDir, "live");
    this.now = now;
  }

  /** Ereignis aus EventSub */
  async handle(type: string, event: any, timestamp: string): Promise<void> {
    if (event?.broadcaster_user_id && String(event.broadcaster_user_id) !== this.userId) return;
    switch (type) {
      case "stream.online":
        if (event.type !== "live") return;
        return this.serial(() => this.online({ id: String(event.id), startedAt: String(event.started_at), title: "" }));
      case "stream.offline":
        return this.serial(() => this.offline(timestamp));
      case "channel.chat.message":
      case "channel.chat.notification": {
        const c = this.current;
        if (!c || c.timer) return;
        const offset = secondsBetween(c.meta.startedAt, timestamp);
        const msg = type === "channel.chat.message" ? fromChatMessage(event, offset) : fromNotification(event, offset);
        if (msg) {
          c.out.write(`${JSON.stringify(msg)}\n`);
          c.messages++;
        }
        return;
      }
    }
  }

  status(): RecorderStatus {
    const c = this.current;
    const stream = c && { id: c.meta.streamId, startedAt: c.meta.startedAt, messages: c.messages };
    if (c?.timer) return { state: "ending", stream, analyzeAt: new Date(c.analyzeAt!).toISOString() };
    if (c) return { state: "recording", stream };
    return { state: this.finalizing.size ? "analyzing" : "waiting" };
  }

  /** Verbindung zu EventSub verloren */
  disconnected(): void {
    const c = this.current;
    if (c && !c.timer && c.gapFrom === undefined) c.gapFrom = secondsBetween(c.meta.startedAt, this.now());
  }

  /**
   * Gleicht mit dem tatsächlichen Stream-Status ab: nach jedem (Neu-)Verbinden
   * und regelmäßig, falls ein online/offline-Ereignis verloren ging. Wertet
   * außerdem liegen gebliebene Mitschnitte beendeter Streams aus.
   */
  sync(): Promise<void> {
    return this.serial(() => this.syncNow());
  }

  private async syncNow(): Promise<void> {
    const live = await fetchLiveStream(this.userId, this.opts.authPath);
    const c = this.current;
    if (live) {
      await this.online(live);
    } else if (c && !c.timer) {
      this.opts.log("Stream ist offline, ohne dass stream.offline ankam.");
      await this.offline(new Date(this.now()).toISOString());
    }

    if (!existsSync(this.liveDir)) return;
    for (const file of await readdir(this.liveDir)) {
      const streamId = file.match(/^(\d+)\.json$/)?.[1];
      if (!streamId || streamId === this.current?.meta.streamId || this.finalizing.has(streamId)) continue;
      const meta: CaptureMeta = JSON.parse(await readFile(join(this.liveDir, file), "utf8"));
      this.opts.log(`Werte liegen gebliebenen Mitschnitt von Stream ${streamId} aus.`);
      void this.finalize(meta);
    }
  }

  /** Alle Dateien schließen, z. B. beim Beenden. Der Mitschnitt wird beim nächsten Start fortgesetzt. */
  async stop(): Promise<void> {
    const c = this.current;
    this.current = undefined;
    if (!c) return;
    clearTimeout(c.timer);
    await new Promise<void>((resolve) => c.out.end(resolve));
  }

  private async online(stream: LiveStream): Promise<void> {
    const c = this.current;
    const nowOffset = secondsBetween(stream.startedAt, this.now());
    if (c && c.meta.streamId === stream.id) {
      if (c.timer) {
        this.opts.log("Stream läuft weiter, Auswertung abgebrochen.");
        clearTimeout(c.timer);
        c.timer = c.analyzeAt = undefined;
        delete c.meta.endedAt;
      }
      if (c.gapFrom !== undefined) {
        c.meta.gaps.push({ from: c.gapFrom, to: nowOffset });
        c.gapFrom = undefined;
      }
      await this.saveMeta(c.meta);
      return;
    }
    if (c) {
      // Neuer Stream, während der alte noch auf seine Auswertung wartet
      clearTimeout(c.timer);
      this.current = undefined;
      await new Promise<void>((resolve) => c.out.end(resolve));
      void this.finalize({ ...c.meta, endedAt: c.meta.endedAt ?? new Date(this.now()).toISOString() });
    }

    await mkdir(this.liveDir, { recursive: true });
    const metaPath = join(this.liveDir, `${stream.id}.json`);
    const chatPath = join(this.liveDir, `${stream.id}.jsonl`);
    let meta: CaptureMeta;
    let count = 0;
    if (existsSync(metaPath)) {
      // Nach einem Neustart: weiterschreiben, die Zeit dazwischen fehlt.
      meta = JSON.parse(await readFile(metaPath, "utf8"));
      delete meta.endedAt;
      const messages = existsSync(chatPath) ? await readMessages(chatPath) : [];
      meta.gaps.push({ from: messages.at(-1)?.offset ?? 0, to: nowOffset });
      count = messages.length;
      this.opts.log(`Setze Mitschnitt von Stream ${stream.id} fort.`);
    } else {
      meta = { streamId: stream.id, startedAt: stream.startedAt, channel: this.channel, gaps: [] };
      if (nowOffset > LATE_START_SECONDS) meta.gaps.push({ from: 0, to: nowOffset });
      this.opts.log(`Stream ${stream.id} läuft, schneide den Chat mit.`);
    }
    this.current = { meta, out: createWriteStream(chatPath, { flags: "a" }), messages: count };
    await this.saveMeta(meta);
  }

  private async offline(timestamp: string): Promise<void> {
    const c = this.current;
    if (!c || c.timer) return;
    c.meta.endedAt = timestamp;
    await this.saveMeta(c.meta);
    const minutes = Math.round(this.opts.graceMs / 60000);
    this.opts.log(`Stream ${c.meta.streamId} ist offline. Auswertung in ${minutes} min, falls er nicht weiterläuft.`);
    c.analyzeAt = this.now() + this.opts.graceMs;
    c.timer = setTimeout(
      () =>
        this.serial(async () => {
          if (this.current !== c) return;
          this.current = undefined;
          await new Promise<void>((resolve) => c.out.end(resolve));
          void this.finalize(c.meta);
        }),
      this.opts.graceMs,
    );
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  private async saveMeta(meta: CaptureMeta): Promise<void> {
    await writeFile(join(this.liveDir, `${meta.streamId}.json`), JSON.stringify(meta, null, 2));
  }

  /** Sucht das VOD, schreibt output/<VOD-ID>/chat.json und startet die Analyse. */
  async finalize(meta: CaptureMeta): Promise<AnalysisResult | undefined> {
    const { streamId } = meta;
    if (this.finalizing.has(streamId)) return undefined;
    this.finalizing.add(streamId);
    const { log } = this.opts;
    try {
      const vod = await this.findVod(streamId);
      if (!vod) log(`Kein VOD zu Stream ${streamId} gefunden (VODs abgeschaltet?). Werte nur den Chat aus.`);

      const chatPath = join(this.liveDir, `${streamId}.jsonl`);
      const messages = existsSync(chatPath) ? await readMessages(chatPath) : [];
      const length = vod?.length || (meta.endedAt ? secondsBetween(meta.startedAt, meta.endedAt) : undefined);
      const missing = meta.gaps.reduce((sum, g) => sum + Math.max(0, g.to - g.from), 0);
      const dir = join(this.opts.outDir, vod?.id ?? streamId);

      let result: AnalysisResult | undefined;
      if (vod && missing > this.opts.maxGapSeconds) {
        log(`Im Mitschnitt fehlen ${Math.round(missing / 60)} min, lade den vollständigen Chat von VOD ${vod.id}.`);
        result = await runAnalysis(vod.id, this.opts.analyze, () => {}, this.opts.outDir).catch((err) => {
          log(`Chat-Download fehlgeschlagen (${err.message}), nehme den Mitschnitt.`);
          return undefined;
        });
      }
      if (!result) {
        const file: LiveChatFile = {
          format: LIVE_FORMAT,
          video: { id: vod?.id, title: vod?.title, channel: meta.channel, length, streamId, startedAt: meta.startedAt },
          messages,
        };
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "chat.json"), JSON.stringify(file));
        if (missing > 0) log(`Hinweis: Im Mitschnitt fehlen insgesamt ${Math.round(missing)} s.`);
        result = await runAnalysis(join(dir, "chat.json"), this.opts.analyze, () => {}, this.opts.outDir);
      }

      // Der Chat steckt jetzt in output/<id>/chat.json.
      await rm(chatPath, { force: true });
      await rm(join(this.liveDir, `${streamId}.json`), { force: true });
      log(`Fertig: ${result.highlights.length} Highlights in ${join(result.dir, "highlights.md")}`);
      await this.opts.onFinished?.(result, log);
      return result;
    } catch (err: any) {
      log(`Auswertung von Stream ${streamId} fehlgeschlagen: ${err.message}`);
      return undefined;
    } finally {
      this.finalizing.delete(streamId);
    }
  }

  private async findVod(streamId: string): Promise<Vod | undefined> {
    for (let attempt = 1; attempt <= this.opts.vodAttempts; attempt++) {
      try {
        const vod = await findVodForStream(streamId, this.opts.authPath);
        if (vod) return vod;
      } catch (err: any) {
        this.opts.log(`VOD-Suche: ${err.message}`);
      }
      if (attempt < this.opts.vodAttempts) await new Promise((resolve) => setTimeout(resolve, this.opts.vodRetryMs));
    }
    return undefined;
  }
}

/** Liest einen Mitschnitt; eine beim Absturz halb geschriebene letzte Zeile wird übersprungen. */
export async function readMessages(path: string): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // unvollständige Zeile
    }
  }
  return messages;
}

export const defaultRecorderOptions = (outDir: string, analyze: AnalyzeOptions): RecorderOptions => ({
  outDir,
  authPath: AUTH_FILE,
  graceMs: 10 * 60_000,
  analyze,
  maxGapSeconds: 120,
  vodAttempts: 5,
  vodRetryMs: 60_000,
  log: (line) => console.log(`${new Date().toISOString()} ${line}`),
});
