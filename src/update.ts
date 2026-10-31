import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as sea from "node:sea";

/**
 * Releases kommen nur von hier: ein eigenes, öffentliches Repository, damit
 * Update-Prüfung und Download auch ohne GitHub-Anmeldung gehen, wenn der
 * Quellcode privat ist. Bis 1.2.2 lagen die Releases im Quellcode-Repository.
 */
export const REPO = "Quasiich/stream-highlights-releases";
// Nur zum Testen auf ein nachgebautes Release umlenkbar
const LATEST_URL = process.env.STREAM_HIGHLIGHTS_RELEASE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_NAME = "stream-highlights.exe";
/** GitHub erlaubt ohne Anmeldung 60 Abfragen pro Stunde, einmal pro Stunde reicht */
const CHECK_INTERVAL_MS = 60 * 60_000;

// Beim Bauen der .exe von esbuild eingesetzt (scripts/build-exe.ts)
declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;

/** Version dieses Programms: in der .exe eingebaut, sonst aus package.json */
export const VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;

/** Git-Commit, aus dem die .exe gebaut wurde; aus dem Quellcode gestartet "Quellcode" */
export const COMMIT: string = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "Quellcode";

export interface UpdateInfo {
  current: string;
  latest?: string;
  /** Neuere Version auf GitHub */
  available: boolean;
  notesUrl?: string;
  publishedAt?: string;
  /** Warum die Prüfung nicht geklappt hat */
  error?: string;
  asset?: { url: string; size: number; sha256: string };
}

/** "v1.10.2" > "1.9.0"; Vorabversionen ("1.2.0-beta") zählen weniger als die fertige */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Antwort von GET /repos/…/releases/latest → UpdateInfo */
export function parseRelease(release: any, current = VERSION): UpdateInfo {
  const latest = String(release?.tag_name ?? "").replace(/^v/, "");
  if (!latest) return { current, available: false, error: "Keine Version auf GitHub gefunden." };
  const asset = (release.assets ?? []).find((a: any) => a.name === ASSET_NAME);
  const sha256 = String(asset?.digest ?? "").match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase();
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    notesUrl: release.html_url,
    publishedAt: release.published_at,
    asset: asset && sha256 ? { url: asset.browser_download_url, size: Number(asset.size), sha256 } : undefined,
  };
}

let cached: { at: number; info: UpdateInfo } | undefined;

/** Fragt GitHub nach dem neuesten Release, höchstens einmal pro Stunde. */
export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  if (!force && cached && Date.now() - cached.at < CHECK_INTERVAL_MS) return cached.info;
  let info: UpdateInfo;
  try {
    const res = await fetch(LATEST_URL, { headers: { Accept: "application/vnd.github+json" } });
    info = res.ok ? parseRelease(await res.json()) : { current: VERSION, available: false, error: `GitHub antwortet ${res.status}.` };
  } catch (err: any) {
    info = { current: VERSION, available: false, error: `GitHub nicht erreichbar (${err.message}).` };
  }
  cached = { at: Date.now(), info };
  return info;
}

/** Name der vorherigen Version neben der .exe, für den Notfall */
export function backupPath(exe = process.execPath): string {
  return join(dirname(exe), basename(exe).replace(/\.exe$/i, "") + ".old.exe");
}

/** Begleitdatei der Notfall-Kopie: welche Version sie ist und wann sie ersetzt wurde */
function backupInfoPath(exe = process.execPath): string {
  return backupPath(exe).replace(/\.exe$/i, ".json");
}

export interface BackupInfo {
  /** Fehlt bei Kopien aus Updates vor 1.2.3 */
  version?: string;
  replacedAt?: string;
  size: number;
}

/** Die Notfall-Kopie, falls vorhanden */
export async function readBackup(exe = process.execPath): Promise<BackupInfo | undefined> {
  const backup = backupPath(exe);
  if (!existsSync(backup)) return undefined;
  const { size } = await stat(backup);
  try {
    const meta = JSON.parse(await readFile(backupInfoPath(exe), "utf8"));
    return { version: meta.version, replacedAt: meta.replacedAt, size };
  } catch {
    return { size };
  }
}

/** Löscht die Notfall-Kopie samt Begleitdatei. */
export async function deleteBackup(exe = process.execPath): Promise<void> {
  try {
    await rm(backupPath(exe), { force: true });
  } catch (err: any) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      throw new Error("Die Notfall-Kopie ist gerade gestartet oder gesperrt und lässt sich nicht löschen.");
    }
    throw err;
  }
  await rm(backupInfoPath(exe), { force: true });
}

/**
 * Lädt die neue .exe, prüft Größe und SHA-256 und tauscht sie gegen die
 * laufende aus. Die bisherige bleibt als stream-highlights.old.exe liegen.
 * Schlägt etwas fehl, bleibt die laufende .exe unverändert.
 */
export async function installUpdate(info: UpdateInfo, onProgress: (percent: number) => void, exe = process.execPath): Promise<void> {
  if (!info.asset) throw new Error("Für diese Version gibt es keine geprüfte .exe auf GitHub.");
  const { url, size, sha256 } = info.asset;
  const fresh = `${exe}.new`;
  await rm(fresh, { force: true });

  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}).`);
    const hash = createHash("sha256");
    const out = createWriteStream(fresh);
    let loaded = 0;
    let lastPercent = -1;
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      loaded += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      const percent = Math.floor((loaded / size) * 100);
      if (percent !== lastPercent) onProgress((lastPercent = Math.min(percent, 99)));
    }
    await new Promise<void>((done, fail) => out.end((err?: Error | null) => (err ? fail(err) : done())));
    if (loaded !== size) throw new Error(`Download unvollständig (${loaded} von ${size} Bytes).`);
    if (hash.digest("hex") !== sha256) throw new Error("Prüfsumme stimmt nicht, die Datei wurde nicht übernommen.");
  } catch (err) {
    await rm(fresh, { force: true });
    throw err;
  }

  // Eine laufende .exe lässt sich unter Windows nicht überschreiben, aber umbenennen.
  const backup = backupPath(exe);
  await rm(backup, { force: true });
  await rm(backupInfoPath(exe), { force: true });
  await rename(exe, backup);
  try {
    await rename(fresh, exe);
  } catch (err) {
    await rename(backup, exe);
    await rm(fresh, { force: true });
    throw err;
  }
  await writeFile(backupInfoPath(exe), JSON.stringify({ version: info.current, replacedAt: new Date().toISOString() }, null, 2)).catch(() => {});
  onProgress(100);
}

/** Startet die (neue) .exe in einem eigenen Konsolenfenster, ohne erneut den Browser zu öffnen. */
export function launchNewVersion(exe = process.execPath, args: string[] = []): Promise<void> {
  // "start" öffnet ein neues Konsolenfenster; cmd selbst bleibt unsichtbar.
  // --no-open zusätzlich zu --updated, damit auch Versionen ohne --updated
  // keinen zweiten Browser-Tab öffnen.
  // Nicht detached: Das wäre unter Windows eine neue Prozessgruppe, und darin
  // ist Strg+C abgeschaltet, vererbt bis in die neue .exe (ließ sich dann nur
  // per Fenster-X oder Strg+Pause beenden). Dafür beendet Node cmd mit der
  // alten .exe; deshalb erst aufhören, wenn cmd die neue gestartet hat. Die
  // neue .exe selbst löst "start" mit eigenem Fenster ab, sie läuft weiter.
  const child = spawn("cmd.exe", ["/d", "/c", "start", '""', `"${exe}"`, "--updated", "--no-open", ...args], {
    cwd: dirname(exe),
    stdio: "ignore",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  return new Promise<void>((done) => {
    child.once("exit", () => done());
    child.once("error", () => done());
    // Hängt cmd wider Erwarten, trotzdem weitermachen
    setTimeout(done, 10_000).unref();
  });
}

/** Nur die .exe kann sich selbst ersetzen, nicht der Quellcode (`npm start`). */
export function canSelfUpdate(): boolean {
  return sea.isSea() && process.platform === "win32" && existsSync(process.execPath);
}
