import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const EXE = process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI";
const FFMPEG = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const RELEASES_URL = "https://api.github.com/repos/lay295/TwitchDownloader/releases/latest";

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
      output = (output + text).slice(-2000);
      for (const m of text.matchAll(/\[STATUS\] - ([^\[\r\n]*?)\s*(\d+)%/g)) onStatus(m[1], Number(m[2]));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => reject(new Error(`TwitchDownloaderCLI konnte nicht gestartet werden: ${err.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${failure} fehlgeschlagen (Code ${code}). ${output.trim().split(/\r?\n/).at(-1) ?? ""}`)),
    );
  });
}

/**
 * Sucht ffmpeg (für den Clip-Schnitt) und lässt es beim ersten Mal von
 * TwitchDownloaderCLI in den Programmordner laden.
 */
export async function ensureFfmpeg(downloader: string, onProgress: ToolProgress = () => {}): Promise<string> {
  const found = findFfmpeg();
  if (found) return found;
  onProgress("Lade ffmpeg (einmalig) …", 0);
  await runTwitchDownloader(downloader, ["ffmpeg", "--download", "--banner", "false"], "ffmpeg-Download", (_, percent) =>
    onProgress("Lade ffmpeg (einmalig) …", percent),
  );
  if (!existsSync(resolve(FFMPEG))) throw new Error("ffmpeg wurde nicht gefunden, obwohl der Download geklappt hat.");
  onProgress("ffmpeg installiert.", 100);
  return resolve(FFMPEG);
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
