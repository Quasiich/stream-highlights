import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const EXE = process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI";
const FFMPEG = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const RELEASES_URL = "https://api.github.com/repos/lay295/TwitchDownloader/releases/latest";
/**
 * ffmpeg für Windows (gyan.dev, verlinkt von ffmpeg.org) mit Prüfsumme daneben.
 * FFMPEG_ZIP_URL ersetzt die Adresse, z. B. für Tests; die Prüfsumme liegt
 * immer unter <Adresse>.sha256.
 */
const FFMPEG_ZIP_URL = process.env.FFMPEG_ZIP_URL || "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/** Namensteil des passenden Release-Downloads, z. B. TwitchDownloaderCLI-1.56.5-Windows-x64.zip */
const ASSET_SUFFIX: Record<string, string> = {
  "win32-x64": "Windows-x64.zip",
  "linux-x64": "Linux-x64.zip",
  "darwin-arm64": "MacOSArm64.zip",
  "darwin-x64": "MacOS-x64.zip",
};

export type ToolProgress = (message: string, percent?: number) => void;

/**
 * Entpacker für die Zips. Unter Windows immer das mitgelieferte tar aus
 * System32: Ein GNU-tar weiter vorne im PATH (Git for Windows, MSYS2, Cygwin)
 * hält "C:\…" für einen Netzwerk-Rechner und bricht ab.
 */
export function tarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(system) ? system : "tar";
}

/** Programm im Programmordner oder im PATH, sonst undefined. */
function findTool(file: string, name: string): string | undefined {
  const local = resolve(file);
  if (existsSync(local)) return local;
  // windowsHide: sonst hängt "where" kurz am Konsolenfenster der .exe
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  const found = which.status === 0 ? which.stdout.split(/\r?\n/)[0]?.trim() : "";
  return found || undefined;
}

/** TwitchDownloaderCLI im Programmordner oder im PATH, sonst undefined. */
export function findTwitchDownloader(): string | undefined {
  return findTool(EXE, "TwitchDownloaderCLI");
}

/** ffmpeg im Programmordner oder im PATH, sonst undefined. */
export function findFfmpeg(): string | undefined {
  return findTool(FFMPEG, "ffmpeg");
}

/**
 * Startet TwitchDownloaderCLI und meldet Zeilen wie "[STATUS] - Downloading 42%"
 * als Schritt und Prozent. Schlägt es fehl, steht die letzte Ausgabezeile im Fehler.
 */
/** Twitch oder GitHub nicht erreichbar: Firewall, Virenschutz, Proxy oder kein Internet */
export class NetworkBlockedError extends Error {
  readonly network = true;
}

// Fehlertexte von .NET (TwitchDownloaderCLI) und Node, die auf eine blockierte Verbindung hindeuten
const NETWORK_ERROR =
  /HttpRequestException|SocketException|WebException|No such host|name (?:or service )?not known|timed? ?out|connection (?:refused|reset|attempt)|Zugriff verweigert|access (?:is )?denied|forbidden by its access permissions|Verbindung|SSL|certificate|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed/i;

/**
 * Macht aus der Ausgabe eines abgebrochenen Programms eine lesbare Meldung:
 * Stacktrace-Zeilen ("at …", "in /home/runner/…") fallen weg, bei einer
 * .NET-Exception zählt deren Text. Sieht es nach einer blockierten Verbindung
 * aus, gibt es einen NetworkBlockedError mit Hinweis, was zu erlauben ist.
 */
export function explainToolError(output: string, failure: string, exe: string, code?: number | null): Error {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s|^---|\bin [/\\].*:line \d+$/.test(l));
  const exception = lines.map((l) => l.match(/(?:^|\s)(?:[\w.]+Exception): (.+)$/)?.[1]).find(Boolean);
  const detail = (exception ?? lines.at(-1) ?? "").replace(/\s+/g, " ").slice(0, 300);
  if (NETWORK_ERROR.test(output)) {
    return new NetworkBlockedError(
      `${failure}: Das Programm kommt nicht ins Internet (${detail || "keine Verbindung"}). ` +
        `Vermutlich blockieren Firewall oder Virenschutz ${exe.split(/[\\/]/).pop()}: bitte dort den Internetzugriff für ` +
        `${exe} erlauben und es erneut versuchen.`,
    );
  }
  return new Error(`${failure} fehlgeschlagen${code === undefined || code === null ? "" : ` (Code ${code})`}. ${detail}`.trim());
}

export function runTwitchDownloader(
  exe: string,
  args: string[],
  failure: string,
  onStatus: (step: string, percent: number) => void = () => {},
): Promise<void> {
  return new Promise<void>((resolveRun, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let output = "";
    const onData = (data: Buffer) => {
      const text = data.toString();
      output = (output + text).slice(-4000);
      for (const m of text.matchAll(/\[STATUS\] - ([^\[\r\n]*?)\s*(\d+)%/g)) onStatus(m[1], Number(m[2]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => reject(new Error(`TwitchDownloaderCLI konnte nicht gestartet werden: ${err.message}`)));
    child.on("close", (code) => (code === 0 ? resolveRun() : reject(explainToolError(output, failure, exe, code))));
  });
}

/**
 * Sucht ffmpeg (für Clips und Ton) und lädt es beim ersten Mal in den
 * Programmordner: unter Windows selbst von gyan.dev (mit Prüfsumme), sonst
 * oder wenn das nicht klappt über TwitchDownloaderCLI. Wer ffmpeg von Hand
 * besorgt, legt ffmpeg.exe einfach in den Programmordner.
 */
export async function ensureFfmpeg(downloader?: string, onProgress: ToolProgress = () => {}): Promise<string> {
  const found = findFfmpeg();
  if (found) return found;
  let ownError: Error | undefined;
  if (process.platform === "win32" || process.env.FFMPEG_ZIP_URL) {
    try {
      await downloadFfmpeg(onProgress);
      onProgress("ffmpeg installiert.", 100);
      return resolve(FFMPEG);
    } catch (err: any) {
      ownError = err;
    }
  }
  downloader ??= await ensureTwitchDownloader(onProgress);
  onProgress("Lade ffmpeg über TwitchDownloaderCLI (einmalig) …", 0);
  try {
    await runTwitchDownloader(downloader, ["ffmpeg", "--download", "--banner", "false"], "ffmpeg-Download", (_, percent) =>
      onProgress("Lade ffmpeg über TwitchDownloaderCLI (einmalig) …", percent),
    );
  } catch (err: any) {
    const hint = " Alternativ ffmpeg.exe von https://www.gyan.dev/ffmpeg/builds/ von Hand in den Programmordner legen.";
    if (ownError instanceof NetworkBlockedError && err instanceof NetworkBlockedError) {
      // Beide Wege blockiert: kurz sagen, welche beiden Programme ins Internet dürfen müssen
      throw new NetworkBlockedError(
        "ffmpeg konnte nicht geladen werden: Weder stream-highlights noch TwitchDownloaderCLI kommen ins Internet. " +
          `Bitte in Firewall bzw. Virenschutz beiden den Internetzugriff erlauben (${process.execPath} und ${downloader}).${hint}`,
      );
    }
    const message = `${ownError ? `ffmpeg-Download fehlgeschlagen (${ownError.message}). ` : ""}${err.message}${hint}`;
    throw err instanceof NetworkBlockedError || ownError instanceof NetworkBlockedError ? new NetworkBlockedError(message) : new Error(message);
  }
  if (!existsSync(resolve(FFMPEG))) throw new Error("ffmpeg wurde nicht gefunden, obwohl der Download geklappt hat.");
  onProgress("ffmpeg installiert.", 100);
  return resolve(FFMPEG);
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function findIn(dir: string, name: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const found = findIn(path, name);
      if (found) return found;
    }
  }
  return undefined;
}

/** Lädt die ffmpeg-Zip, prüft die SHA-256-Prüfsumme und übernimmt nur ffmpeg(.exe) in den Programmordner. */
export async function downloadFfmpeg(onProgress: ToolProgress = () => {}): Promise<void> {
  const get = (url: string) =>
    fetch(url).catch((err) => {
      throw explainToolError(`${err.message} ${err.cause?.code ?? ""}`, "ffmpeg-Download", process.execPath);
    });
  onProgress("Lade ffmpeg (einmalig, ca. 100 MB) …", 0);
  const sumRes = await get(FFMPEG_ZIP_URL + ".sha256");
  if (!sumRes.ok) throw new Error(`Prüfsumme für ffmpeg nicht erreichbar (${sumRes.status}).`);
  const expected = (await sumRes.text()).trim().split(/\s+/)[0]?.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) throw new Error("Prüfsumme für ffmpeg ist ungültig.");

  const res = await get(FFMPEG_ZIP_URL);
  if (!res.ok || !res.body) throw new Error(`ffmpeg-Download fehlgeschlagen (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = await mkdtemp(resolve(".ffmpeg-"));
  try {
    const zip = join(tmp, "ffmpeg.zip");
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    let last = -1;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      loaded += chunk.length;
      const percent = total ? Math.floor((loaded / total) * 100) : undefined;
      if (percent !== undefined && percent !== last) onProgress("Lade ffmpeg (einmalig, ca. 100 MB) …", (last = percent));
    }
    await writeFile(zip, Buffer.concat(chunks));
    if ((await sha256(zip)) !== expected) throw new Error("ffmpeg-Download ist beschädigt (Prüfsumme stimmt nicht).");
    const out = join(tmp, "x");
    await mkdir(out);
    const unpacked = spawnSync(tarCommand(), ["-xf", zip, "-C", out], { encoding: "utf8", windowsHide: true });
    if (unpacked.status !== 0) throw new Error(`Entpacken von ffmpeg fehlgeschlagen: ${unpacked.stderr || unpacked.error?.message}`);
    const exe = findIn(out, FFMPEG);
    if (!exe) throw new Error(`${FFMPEG} nicht im Download gefunden.`);
    await rename(exe, resolve(FFMPEG));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Baut einmal eine Verbindung über TwitchDownloaderCLI auf (Infos zu einem
 * VOD). Damit fragen Firewall oder Virenschutz gleich nach der Erlaubnis,
 * solange jemand am PC ist, und nicht erst nach dem Stream. Wirft einen
 * NetworkBlockedError, wenn die Verbindung blockiert ist.
 */
export async function checkTwitchDownloaderNetwork(exe: string, videoId: string): Promise<void> {
  try {
    await runTwitchDownloader(exe, ["info", "--id", videoId, "--format", "raw", "--banner", "false"], "Verbindungstest von TwitchDownloaderCLI");
  } catch (err) {
    // Andere Fehler (z. B. VOD inzwischen gelöscht) sagen nichts über die Verbindung
    if (err instanceof NetworkBlockedError) throw err;
  }
}

/**
 * Sucht TwitchDownloaderCLI und lädt es beim ersten Mal selbst aus dem
 * offiziellen GitHub-Release (lay295/TwitchDownloader) in den Programmordner.
 */
export async function ensureTwitchDownloader(onProgress: ToolProgress = () => {}): Promise<string> {
  const found = findTwitchDownloader();
  if (found) return found;

  const suffix = ASSET_SUFFIX[`${process.platform}-${process.arch}`];
  if (!suffix) {
    throw new Error(
      `Für ${process.platform}-${process.arch} gibt es keinen automatischen Download. Bitte TwitchDownloaderCLI von ` +
        "https://github.com/lay295/TwitchDownloader/releases herunterladen und in den Programmordner legen.",
    );
  }

  onProgress("Suche aktuelle Version von TwitchDownloaderCLI …");
  const release: any = await (await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } })).json();
  const asset = (release.assets ?? []).find((a: any) => /^TwitchDownloaderCLI-/.test(a.name) && a.name.endsWith(suffix));
  if (!asset) throw new Error(`Kein passender Download im Release ${release.tag_name ?? "?"} gefunden.`);

  const res = await fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastPercent = -1;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    loaded += chunk.length;
    const percent = total ? Math.floor((loaded / total) * 100) : undefined;
    if (percent !== lastPercent) {
      onProgress(`Lade TwitchDownloaderCLI ${release.tag_name} …`, percent);
      lastPercent = percent ?? lastPercent;
    }
  }

  // In einen eigenen leeren Ordner entpacken und nur die .exe übernehmen.
  const tmp = await mkdtemp(resolve(".twitchdownloader-"));
  try {
    const zip = join(tmp, asset.name);
    await writeFile(zip, Buffer.concat(chunks));
    const unpacked = spawnSync(tarCommand(), ["-xf", zip, "-C", tmp], { encoding: "utf8", windowsHide: true });
    if (unpacked.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${unpacked.stderr || unpacked.error?.message}`);
    if (!existsSync(join(tmp, EXE))) throw new Error(`${EXE} nicht im Download gefunden.`);
    await rename(join(tmp, EXE), resolve(EXE));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  onProgress(`TwitchDownloaderCLI ${release.tag_name} installiert.`, 100);
  return resolve(EXE);
}
