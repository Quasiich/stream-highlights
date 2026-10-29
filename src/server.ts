import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { defaultOptions } from "./analyze.ts";
import { listReports, OUTPUT_DIR, parseVideoId, type Progress, readReport, runAnalysis } from "./pipeline.ts";
import { findTwitchDownloader } from "./tools.ts";
import { AUTH_FILE, loadAuth, startLogin } from "./twitch.ts";

export const PORT = 4777;

interface Job {
  id: string;
  input: string;
  /** Alle bisherigen SSE-Nachrichten, damit ein neu verbundener Browser alles sieht */
  messages: string[];
  listeners: Set<ServerResponse>;
  finished: boolean;
}

let job: Job | undefined;
let login: { state: "idle" | "pending" | "done" | "error"; userCode?: string; verificationUri?: string; error?: string } = {
  state: "idle",
};

/**
 * Lokaler Server für die Web-Oberfläche. Lauscht nur auf dieser Maschine und
 * nimmt nur Anfragen an, die von der eigenen Seite kommen.
 */
export function startServer(html: () => Promise<string>, port = PORT): Promise<Server[]> {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // Schutz gegen DNS-Rebinding und Anfragen fremder Webseiten
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Unbekannter Host" });
    const origin = req.headers.origin;
    if (req.method !== "GET" && (!origin || !allowedHosts.has(origin.replace(/^http:\/\//, "")))) {
      return send(res, 403, { error: "Fremde Herkunft" });
    }

    try {
      await route(req, res, html);
    } catch (err: any) {
      if (!res.headersSent) send(res, 500, { error: err.message });
      else res.end();
    }
  };

  // IPv4 und IPv6, da "localhost" je nach System auf ::1 auflöst
  const listen = (host: string) =>
    new Promise<Server>((resolveListen, reject) => {
      const server = createServer(handler);
      server.once("error", reject);
      server.listen(port, host, () => resolveListen(server));
    });
  return Promise.all([listen("127.0.0.1"), listen("::1").catch(() => undefined)]).then((servers) =>
    servers.filter((s): s is Server => s !== undefined),
  );
}

async function route(req: IncomingMessage, res: ServerResponse, html: () => Promise<string>) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(await html());
  }

  if (req.method === "GET" && path === "/api/status") {
    const auth = await loadAuth();
    return send(res, 200, {
      twitch: auth ? { login: auth.login ?? null } : null,
      clientId: auth?.clientId ?? null,
      downloader: Boolean(findTwitchDownloader()),
      running: job && !job.finished ? { id: job.id, input: job.input } : null,
      defaults: {
        top: defaultOptions.top,
        bucket: defaultOptions.bucketSeconds,
        gap: defaultOptions.minGapSeconds,
        markerLead: defaultOptions.markerLeadSeconds,
        minGifts: defaultOptions.eventMinimums.giftedSubs,
        minRaid: defaultOptions.eventMinimums.raidViewers,
        minBits: defaultOptions.eventMinimums.bits,
      },
    });
  }

  if (req.method === "GET" && path === "/api/reports") return send(res, 200, await listReports());

  const reportMatch = path.match(/^\/api\/reports\/([\w-]+)$/);
  if (req.method === "GET" && reportMatch) {
    const report = await readReport(reportMatch[1]);
    return report ? send(res, 200, report) : send(res, 404, { error: "Analyse nicht gefunden" });
  }

  if (req.method === "POST" && path === "/api/analyze") {
    if (job && !job.finished) return send(res, 409, { error: "Es läuft schon eine Analyse." });
    const body = await readJson(req);
    const input = String(body.input ?? "").trim();
    if (!parseVideoId(input)) return send(res, 400, { error: "Bitte einen VOD-Link oder eine VOD-ID angeben, z. B. https://www.twitch.tv/videos/2912392719" });
    const opts = {
      ...defaultOptions,
      top: num(body.top, defaultOptions.top),
      bucketSeconds: num(body.bucket, defaultOptions.bucketSeconds),
      minGapSeconds: num(body.gap, defaultOptions.minGapSeconds),
      markerLeadSeconds: num(body.markerLead, defaultOptions.markerLeadSeconds),
      eventMinimums: {
        giftedSubs: num(body.minGifts, defaultOptions.eventMinimums.giftedSubs),
        raidViewers: num(body.minRaid, defaultOptions.eventMinimums.raidViewers),
        bits: num(body.minBits, defaultOptions.eventMinimums.bits),
      },
    };
    if (body.refresh) await rm(join(OUTPUT_DIR, parseVideoId(input)!, "chat.json"), { force: true });

    const current: Job = { id: Date.now().toString(36), input, messages: [], listeners: new Set(), finished: false };
    job = current;
    const emit = (event: string, data: unknown) => {
      const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      current.messages.push(message);
      for (const l of current.listeners) l.write(message);
    };
    runAnalysis(input, opts, (p: Progress) => emit("progress", p))
      .then(({ report }) => emit("done", { id: report.video.id }))
      .catch((err) => emit("failed", { error: err.message }))
      .finally(() => {
        current.finished = true;
        for (const l of current.listeners) l.end();
        current.listeners.clear();
      });
    return send(res, 202, { id: current.id });
  }

  const jobMatch = path.match(/^\/api\/jobs\/(\w+)$/);
  if (req.method === "GET" && jobMatch) {
    if (!job || job.id !== jobMatch[1]) return send(res, 404, { error: "Analyse nicht gefunden" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    for (const m of job.messages) res.write(m);
    if (job.finished) return res.end();
    const current = job;
    current.listeners.add(res);
    req.on("close", () => current.listeners.delete(res));
    return;
  }

  if (path === "/api/login" && req.method === "GET") return send(res, 200, login);

  if (path === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const clientId = String(body.clientId ?? "").trim() || (await loadAuth())?.clientId;
    if (!clientId) return send(res, 400, { error: "Bitte die Client-ID deiner Twitch-App angeben." });
    const pending = await startLogin(clientId);
    login = { state: "pending", userCode: pending.userCode, verificationUri: pending.verificationUri };
    pending.done.then(
      () => (login = { state: "done" }),
      (err) => (login = { state: "error", error: err.message }),
    );
    openUrl(pending.verificationUri);
    return send(res, 200, login);
  }

  if (path === "/api/logout" && req.method === "POST") {
    await rm(AUTH_FILE, { force: true });
    login = { state: "idle" };
    return send(res, 200, { ok: true });
  }

  const folderMatch = path.match(/^\/api\/reports\/([\w-]+)\/open$/);
  if (req.method === "POST" && folderMatch) {
    const dir = resolve(OUTPUT_DIR, folderMatch[1]);
    if (!existsSync(dir)) return send(res, 404, { error: "Ordner nicht gefunden" });
    openPath(dir);
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Nicht gefunden" });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Anfrage zu groß");
  }
  return raw ? JSON.parse(raw) : {};
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return value !== "" && value !== undefined && value !== null && Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Öffnet eine Webadresse im Standardbrowser. */
export function openUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  openPath(url);
}

function openPath(target: string) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["explorer", [target]]
      : process.platform === "darwin"
        ? ["open", [target]]
        : ["xdg-open", [target]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export async function readHtmlFromDisk(): Promise<string> {
  return readFile(resolve("ui/index.html"), "utf8");
}
