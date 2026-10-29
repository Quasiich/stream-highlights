import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPath, compareVersions, installUpdate, parseRelease, type UpdateInfo } from "../src/update.ts";

test("compareVersions vergleicht Zahl für Zahl, Vorabversionen zählen weniger", () => {
  assert.equal(compareVersions("1.1.1", "1.1.0"), 1);
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("1.0.2", "1.1.0"), -1);
  assert.equal(compareVersions("1.2.0-beta", "1.2.0"), -1);
  assert.equal(compareVersions("1.2.0", "1.2.0-beta"), 1);
});

const release = {
  tag_name: "v1.2.0",
  html_url: "https://github.com/Quasiich/stream-highlights/releases/tag/v1.2.0",
  published_at: "2026-11-01T10:00:00Z",
  assets: [
    {
      name: "stream-highlights.exe",
      size: 10,
      digest: "sha256:" + "ab".repeat(32),
      browser_download_url: "https://github.com/Quasiich/stream-highlights/releases/download/v1.2.0/stream-highlights.exe",
    },
  ],
};

test("parseRelease erkennt neuere Versionen und braucht eine Prüfsumme", () => {
  const info = parseRelease(release, "1.1.1");
  assert.equal(info.available, true);
  assert.equal(info.latest, "1.2.0");
  assert.equal(info.asset?.sha256, "ab".repeat(32));
  assert.equal(parseRelease(release, "1.2.0").available, false);
  assert.equal(parseRelease(release, "1.3.0").available, false);

  const ohnePruefsumme = { ...release, assets: [{ ...release.assets[0], digest: undefined }] };
  assert.equal(parseRelease(ohnePruefsumme, "1.1.1").asset, undefined, "ohne Prüfsumme nicht installierbar");
  assert.equal(parseRelease({ ...release, assets: [] }, "1.1.1").asset, undefined);
});

test("backupPath legt die alte Version neben die .exe", () => {
  assert.equal(backupPath(join("C:", "Tools", "stream-highlights.exe")), join("C:", "Tools", "stream-highlights.old.exe"));
});

/** Ordner mit einer "laufenden" .exe und gefälschtem Download */
async function setup(t: any, download: Buffer, claimed = download) {
  const dir = await mkdtemp(join(tmpdir(), "update-"));
  const exe = join(dir, "stream-highlights.exe");
  await writeFile(exe, "alte version");
  const info: UpdateInfo = {
    current: "1.1.1",
    latest: "1.2.0",
    available: true,
    asset: { url: "https://example.invalid/stream-highlights.exe", size: claimed.length, sha256: createHash("sha256").update(claimed).digest("hex") },
  };
  t.mock.method(globalThis, "fetch", async () => new Response(new Uint8Array(download)));
  return { dir, exe, info };
}

test("installUpdate tauscht die .exe und behält die alte als .old.exe", async (t) => {
  const neu = Buffer.from("neue version!");
  const { exe, info } = await setup(t, neu);
  const progress: number[] = [];
  await installUpdate(info, (p) => progress.push(p), exe);
  assert.equal(await readFile(exe, "utf8"), "neue version!");
  assert.equal(await readFile(backupPath(exe), "utf8"), "alte version");
  assert.equal(existsSync(`${exe}.new`), false);
  assert.equal(progress.at(-1), 100);
});

test("bei falscher Prüfsumme bleibt die alte .exe unverändert", async (t) => {
  const { exe, info } = await setup(t, Buffer.from("manipuliert!!"), Buffer.from("echte version"));
  await assert.rejects(installUpdate(info, () => {}, exe), /Prüfsumme/);
  assert.equal(await readFile(exe, "utf8"), "alte version");
  assert.equal(existsSync(backupPath(exe)), false);
  assert.equal(existsSync(`${exe}.new`), false);
});

test("bei unvollständigem Download bleibt die alte .exe unverändert", async (t) => {
  const { exe, info } = await setup(t, Buffer.from("halb"), Buffer.from("vollständige version"));
  await assert.rejects(installUpdate(info, () => {}, exe), /unvollständig/);
  assert.equal(await readFile(exe, "utf8"), "alte version");
  assert.equal(existsSync(`${exe}.new`), false);
});

test("eine ältere .old.exe wird durch die gerade ersetzte Version abgelöst", async (t) => {
  const { exe, info } = await setup(t, Buffer.from("neue version!"));
  await writeFile(backupPath(exe), "uralte version");
  await installUpdate(info, () => {}, exe);
  assert.equal(await readFile(backupPath(exe), "utf8"), "alte version");
});
