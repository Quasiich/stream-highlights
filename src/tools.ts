import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const EXE = process.platform === "win32" ? "TwitchDownloaderCLI.exe" : "TwitchDownloaderCLI";
const RELEASES_URL = "https://api.github.com/repos/lay295/TwitchDownloader/releases/latest";

/** Namensteil des passenden Release-Downloads, z. B. TwitchDownloaderCLI-1.56.5-Windows-x64.zip */
const ASSET_SUFFIX: Record<string, string> = {
  "win32-x64": "Windows-x64.zip",
  "linux-x64": "Linux-x64.zip",
};

export type ToolProgress = (message: string, percent?: number) => void;

/** TwitchDownloaderCLI im Programmordner oder im PATH, sonst undefined. */
export function findTwitchDownloader(): string | undefined {
  const local = resolve(EXE);
  if (existsSync(local)) return local;
  // windowsHide: sonst hängt "where" kurz am Konsolenfenster der .exe
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["TwitchDownloaderCLI"], { encoding: "utf8", windowsHide: true });
  const found = which.status === 0 ? which.stdout.split(/\r?\n/)[0]?.trim() : "";
  return found || undefined;
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
    const unpacked = spawnSync("tar", ["-xf", zip, "-C", tmp], { encoding: "utf8" });
    if (unpacked.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${unpacked.stderr || unpacked.error?.message}`);
    if (!existsSync(join(tmp, EXE))) throw new Error(`${EXE} nicht im Download gefunden.`);
    await rename(join(tmp, EXE), resolve(EXE));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  onProgress(`TwitchDownloaderCLI ${release.tag_name} installiert.`, 100);
  return resolve(EXE);
}
