import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadChat } from "./chat.ts";
import { defaultOptions, findHighlights } from "./analyze.ts";
import { collectEvents, isNotable, summarize } from "./events.ts";
import { toConsole, toMarkdown } from "./format.ts";
import { AUTH_FILE, fetchMarkers, type Marker } from "./twitch.ts";

const usage = `Verwendung:
  npm run analyze -- <VOD-ID oder VOD-Link oder chat.json> [Optionen]

Bei einer VOD-ID/einem Link wird der Chat mit TwitchDownloaderCLI geladen
(muss installiert und im PATH sein) und unter output/<id>/chat.json gespeichert.

Optionen:
  --top <n>        Anzahl Highlights (Standard ${defaultOptions.top})
  --bucket <s>     Fenstergröße in Sekunden (Standard ${defaultOptions.bucketSeconds})
  --gap <s>        Mindestabstand zwischen Highlights (Standard ${defaultOptions.minGapSeconds})
  --marker-lead <s>  Vorlauf vor einem Streamer-Marker (Standard ${defaultOptions.markerLeadSeconds})
  --out <ordner>   Ausgabeordner (Standard output)

Nach \`npm run login\` werden bei VODs des eigenen Kanals die Stream-Marker
mitgeladen und immer als Highlight übernommen (siehe README).
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      top: { type: "string" },
      bucket: { type: "string" },
      gap: { type: "string" },
      "marker-lead": { type: "string" },
      out: { type: "string", default: "output" },
      help: { type: "boolean", short: "h" },
    },
  });

  const input = positionals[0];
  if (!input || values.help) {
    console.log(usage);
    process.exit(input ? 0 : 1);
  }

  const videoId = input.match(/(?:videos\/)?(\d{6,})/)?.[1];
  let chatPath = input;
  if (!input.endsWith(".json")) {
    if (!videoId) throw new Error(`Keine VOD-ID erkannt in "${input}"`);
    chatPath = await downloadChat(videoId, join(values.out!, videoId));
  }

  const log = await loadChat(chatPath);
  log.videoId ??= videoId;

  const markers = log.videoId ? await loadMarkers(log.videoId) : [];

  const highlights = findHighlights(
    log,
    {
      ...defaultOptions,
      top: num(values.top, defaultOptions.top),
      bucketSeconds: num(values.bucket, defaultOptions.bucketSeconds),
      minGapSeconds: num(values.gap, defaultOptions.minGapSeconds),
      markerLeadSeconds: num(values["marker-lead"], defaultOptions.markerLeadSeconds),
    },
    markers,
  );

  const events = collectEvents(log);

  console.log(toConsole(log, highlights, events));

  const dir = join(values.out!, log.videoId ?? "local");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "highlights.json"),
    JSON.stringify({ video: { id: log.videoId, title: log.title, channel: log.channel, length: log.length }, highlights, markers, events: { summary: summarize(events), list: events.filter(isNotable) } }, null, 2),
  );
  await writeFile(join(dir, "highlights.md"), toMarkdown(log, highlights, events));
  console.log(`Gespeichert: ${join(dir, "highlights.json")} und highlights.md`);
}

async function downloadChat(videoId: string, dir: string): Promise<string> {
  const target = join(dir, "chat.json");
  if (existsSync(target)) {
    console.log(`Chat bereits vorhanden: ${target}`);
    return target;
  }
  await mkdir(dir, { recursive: true });
  console.log(`Lade Chat von VOD ${videoId} …`);
  const res = spawnSync("TwitchDownloaderCLI", ["chatdownload", "--id", videoId, "-o", target], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error || res.status !== 0) {
    throw new Error(
      "TwitchDownloaderCLI konnte nicht gestartet werden. Installieren: https://github.com/lay295/TwitchDownloader/releases " +
        "(TwitchDownloaderCLI-…-Windows-x64.zip entpacken und den Ordner in den PATH legen oder die .exe hier ins Projekt legen).",
    );
  }
  return target;
}

/** Stream-Marker sind optional: ohne Anmeldung oder bei fremden VODs geht es nur mit dem Chat weiter. */
async function loadMarkers(videoId: string): Promise<Marker[]> {
  if (!existsSync(AUTH_FILE)) {
    console.log("Hinweis: Ohne `npm run login` werden keine Streamer-Marker berücksichtigt (siehe README).\n");
    return [];
  }
  try {
    const markers = await fetchMarkers(videoId);
    console.log(`${markers.length} Streamer-Marker geladen.\n`);
    return markers;
  } catch (err: any) {
    console.warn(`Streamer-Marker nicht geladen: ${err.message} Es geht nur mit dem Chat weiter.\n`);
    return [];
  }
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
