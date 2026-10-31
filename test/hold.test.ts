import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isHeld, retriesAutomatically, runAutomation } from "../src/automation.ts";
import { defaultClipSettings } from "../src/clips.ts";
import { defaultDiscordSettings } from "../src/discord.ts";
import type { Report } from "../src/pipeline.ts";
import { explainToolError, NetworkBlockedError, tarCommand } from "../src/tools.ts";

// Ausgabe von TwitchDownloaderCLI wie im Fehlerbericht (ffmpeg-Download ohne Internetzugriff)
const DOTNET_NETWORK_FAILURE = `[STATUS] - Downloading FFmpeg
Unhandled exception. System.Net.Http.HttpRequestException: Es konnte keine Verbindung hergestellt werden, da der Zielcomputer die Verbindung verweigerte. (ffbinaries.com:443)
 ---> System.Net.Sockets.SocketException (10061): Es konnte keine Verbindung hergestellt werden.
   at System.Net.Http.HttpConnectionPool.ConnectToTcpHostAsync(String host, Int32 port, HttpRequestMessage initialRequest, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at TwitchDownloaderCLI.Program.Main(String[] args) in /home/runner/work/TwitchDownloader/TwitchDownloader/TwitchDownloaderCLI/Program.cs:line 31`;

test("explainToolError: blockierte Verbindung wird erkannt und erklärt, ohne Stacktrace", () => {
  const err = explainToolError(DOTNET_NETWORK_FAILURE, "ffmpeg-Download", "C:\\stream\\TwitchDownloaderCLI.exe", 1);
  assert.ok(err instanceof NetworkBlockedError);
  assert.match(err.message, /verweigerte/);
  assert.match(err.message, /Firewall oder Virenschutz TwitchDownloaderCLI\.exe/);
  assert.match(err.message, /C:\\stream\\TwitchDownloaderCLI\.exe erlauben/);
  assert.doesNotMatch(err.message, /Program\.cs|\bat System\./);
});

test("explainToolError: andere Fehler ohne Stacktrace, mit dem eigentlichen Text", () => {
  const out = "Unhandled exception. System.IO.IOException: Datenträger voll\n   at X.Y() in /home/runner/a.cs:line 3";
  const err = explainToolError(out, "Chat-Download", "TwitchDownloaderCLI", 2);
  assert.ok(!(err instanceof NetworkBlockedError));
  assert.equal(err.message, "Chat-Download fehlgeschlagen (Code 2). Datenträger voll");
});

function report(extra: Partial<Report> = {}): Report {
  return {
    video: { id: "123456789", title: "Teststream", channel: "tester", length: 3600 },
    analyzedAt: new Date().toISOString(),
    messageCount: 10,
    highlights: [],
    markers: [],
    events: { summary: { subs: 0, giftedSubs: 0, raids: 0, bits: 0 }, list: [], minimums: { giftedSubs: 5, raidViewers: 10, bits: 500 } },
    ...extra,
  } as Report;
}

const settings = {
  mode: "auto" as const,
  discord: { ...defaultDiscordSettings, enabled: true, webhooks: [{ name: "Test", url: "https://discord.com/api/webhooks/1/abc" }] },
  clips: { ...defaultClipSettings, enabled: false },
};

test("runAutomation hält Discord zurück, wenn die Sprach-Auswertung fehlgeschlagen ist", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hold-"));
  const posts: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any) => {
    posts.push(String(url));
    return new Response(null, { status: 204 });
  });
  const r = report({ voiceNote: "Sprach-Auswertung fehlgeschlagen: kein Internet", voiceFailed: { network: true } });
  const lines: string[] = [];
  const state = await runAutomation({ report: r, dir }, settings, (l) => lines.push(l), dir);

  assert.equal(state, "held");
  assert.deepEqual(posts, [], "nichts an Discord geschickt");
  const saved: Report = JSON.parse(await readFile(join(dir, "highlights.json"), "utf8"));
  assert.ok(isHeld(saved));
  assert.match(saved.automation!.reason!, /kein Internet/);
  assert.ok(retriesAutomatically(saved), "Netzwerkfehler werden automatisch erneut versucht");
  assert.match(lines.join("\n"), /warten/);

  // Freigabe "Ohne Sprache posten": jetzt wird gepostet, seit-Zeitpunkt egal
  const released = await runAutomation({ report: saved, dir }, settings, () => {}, dir, () => {}, { release: true });
  assert.equal(released, "released");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, "highlights.json"), "utf8")).automation.state, "released");
});

test("runAutomation postet normal, wenn alles da ist, und vermerkt das", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hold-"));
  const posts: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: any) => {
    posts.push(String(url));
    return new Response(null, { status: 204 });
  });
  const state = await runAutomation({ report: report(), dir }, settings, () => {}, dir);
  assert.equal(state, "done");
  assert.equal(posts.length, 1);
});

test("andere Fehler der Sprach-Auswertung warten ebenfalls, aber ohne automatische Wiederholung", () => {
  const r = report({ voiceFailed: { network: false }, automation: { state: "held", reason: "Whisper abgestürzt" } });
  assert.equal(retriesAutomatically(r), false);
});

// Dasselbe tar wie das Programm (unter Windows das aus System32, ein GNU-tar im PATH kann keine C:-Pfade)
const hasTar = spawnSync(tarCommand(), ["--version"]).status === 0;

test("ffmpeg-Download prüft die Prüfsumme und übernimmt nur ffmpeg", { skip: !hasTar && "tar fehlt" }, async () => {
  const work = await mkdtemp(join(tmpdir(), "ffdl-"));
  // Archiv mit Unterordner wie bei gyan.dev (tar erkennt das Format selbst, auch unter .zip)
  await mkdir(join(work, "src", "ffmpeg-7.1-essentials_build", "bin"), { recursive: true });
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  await writeFile(join(work, "src", "ffmpeg-7.1-essentials_build", "bin", exe), "FAKE-FFMPEG");
  await writeFile(join(work, "src", "ffmpeg-7.1-essentials_build", "README.txt"), "x");
  const archive = join(work, "ffmpeg.zip");
  assert.equal(spawnSync(tarCommand(), ["-czf", archive, "-C", join(work, "src"), "."]).status, 0);
  const bytes = await readFile(archive);
  let sum = createHash("sha256").update(bytes).digest("hex");

  const server = createServer((req, res) => {
    if (req.url?.endsWith(".sha256")) return res.end(`${sum} *ffmpeg-release-essentials.zip\n`);
    res.setHeader("content-length", bytes.length);
    res.end(bytes);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;
  const env = { ...process.env, FFMPEG_ZIP_URL: `http://127.0.0.1:${port}/ffmpeg-release-essentials.zip` };
  // Unter Windows braucht import() eine file://-Adresse statt "C:/…"
  const script = `import("${pathToFileURL(join(process.cwd(), "src/tools.ts")).href}").then((t) => t.downloadFfmpeg()).then(() => console.log("OK"), (e) => { console.log("FEHLER " + e.message); })`;
  const run = (cwd: string) =>
    new Promise<string>((done) => {
      // Im leeren Testordner gibt es kein node_modules: tsx über den absoluten Pfad laden
      const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "-e", script], { cwd, env });
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d));
      child.stderr.on("data", (d: Buffer) => (out += d));
      child.on("close", () => done(out.trim()));
    });

  try {
    const ok = join(work, "ok");
    await mkdir(ok);
    assert.equal(await run(ok), "OK");
    assert.equal(await readFile(join(ok, exe), "utf8"), "FAKE-FFMPEG");
    assert.ok(!existsSync(join(ok, "README.txt")), "nur ffmpeg wird übernommen");

    sum = "0".repeat(64);
    const bad = join(work, "bad");
    await mkdir(bad);
    assert.match(await run(bad), /FEHLER .*Prüfsumme stimmt nicht/);
    assert.ok(!existsSync(join(bad, exe)), "beschädigter Download landet nicht im Programmordner");
  } finally {
    server.close();
  }
});
