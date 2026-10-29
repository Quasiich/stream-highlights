import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultOptions } from "./analyze.ts";
import { toConsole } from "./format.ts";
import { OUTPUT_DIR, runAnalysis } from "./pipeline.ts";

const usage = `Verwendung:
  npm run analyze -- <VOD-ID oder VOD-Link oder chat.json> [Optionen]

Bei einer VOD-ID/einem Link wird der Chat mit TwitchDownloaderCLI geladen
(wird beim ersten Mal automatisch heruntergeladen) und unter
output/<id>/chat.json gespeichert.

Optionen:
  --top <n>        Anzahl Chat-Highlights (Standard ${defaultOptions.top})
  --bucket <s>     Fenstergröße in Sekunden (Standard ${defaultOptions.bucketSeconds})
  --gap <s>        Mindestabstand zwischen Highlights (Standard ${defaultOptions.minGapSeconds})
  --marker-lead <s>  Vorlauf vor einem Streamer-Marker (Standard ${defaultOptions.markerLeadSeconds})
  --min-gifts <n>  Gift-Bomben ab n Subs einzeln auflisten (Standard ${defaultOptions.eventMinimums.giftedSubs})
  --min-raid <n>   Raids ab n Zuschauern einzeln auflisten (Standard ${defaultOptions.eventMinimums.raidViewers})
  --min-bits <n>   Cheers ab n Bits einzeln auflisten (Standard ${defaultOptions.eventMinimums.bits})
  --out <ordner>   Ausgabeordner (Standard ${OUTPUT_DIR})

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
      "min-gifts": { type: "string" },
      "min-raid": { type: "string" },
      "min-bits": { type: "string" },
      out: { type: "string", default: OUTPUT_DIR },
      help: { type: "boolean", short: "h" },
    },
  });

  const input = positionals[0];
  if (!input || values.help) {
    console.log(usage);
    process.exit(input ? 0 : 1);
  }

  const opts = {
    ...defaultOptions,
    top: num(values.top, defaultOptions.top),
    bucketSeconds: num(values.bucket, defaultOptions.bucketSeconds),
    minGapSeconds: num(values.gap, defaultOptions.minGapSeconds),
    markerLeadSeconds: num(values["marker-lead"], defaultOptions.markerLeadSeconds),
    eventMinimums: {
      giftedSubs: num(values["min-gifts"], defaultOptions.eventMinimums.giftedSubs),
      raidViewers: num(values["min-raid"], defaultOptions.eventMinimums.raidViewers),
      bits: num(values["min-bits"], defaultOptions.eventMinimums.bits),
    },
  };

  let lastLine = "";
  const { log, highlights, events, report, dir } = await runAnalysis(
    input,
    opts,
    ({ message, percent }) => {
      // Fortschritt in einer Zeile überschreiben, fertige Schritte stehen lassen
      const line = percent === undefined ? message : `${message} ${percent}%`;
      if (line === lastLine) return;
      process.stdout.write(`\r${line.padEnd(lastLine.length)}${percent === undefined || percent === 100 ? "\n" : ""}`);
      lastLine = percent === undefined || percent === 100 ? "" : line;
    },
    values.out!,
  );

  if (report.markerNote) console.log(`Hinweis: ${report.markerNote}`);
  console.log(`\n${toConsole(log, highlights, events, opts.eventMinimums)}`);
  console.log(`Gespeichert: ${join(dir, "highlights.json")} und highlights.md`);
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : fallback;
}

main().catch((err) => {
  console.error(`\nFehler: ${err.message}`);
  process.exit(1);
});
