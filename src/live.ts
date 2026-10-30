import { parseArgs } from "node:util";
import { defaultOptions } from "./analyze.ts";
import { loadAutomation, runAutomation } from "./automation.ts";
import { startLive } from "./livemode.ts";
import { OUTPUT_DIR } from "./pipeline.ts";
import { defaultRecorderOptions } from "./recorder.ts";
import { SETTINGS_FILE } from "./settings.ts";

const usage = `Verwendung:
  npm run live [-- Optionen]

Läuft dauerhaft (z. B. als systemd-Dienst auf einem Server), schneidet den
Chat deines Kanals während jedes Streams über Twitch EventSub mit und wertet
ihn nach dem Stream-Ende automatisch aus. Ergebnis wie bei
\`npm run analyze\` in output/<VOD-ID>/. Vorher einmal \`npm run login\`.
In der Oberfläche (\`npm start\` bzw. .exe) gibt es dafür den Schalter
„Live-Mitschnitt“.

Optionen:
  --grace <min>    Nach dem Stream-Ende so lange warten, falls er nur kurz
                   abgebrochen ist (Standard 10)
  --max-gap <s>    Fehlen im Mitschnitt mehr Sekunden, wird der Chat nach dem
                   Stream komplett per TwitchDownloaderCLI geladen
                   (Standard 120, 0 = nie)
  --out <ordner>   Ausgabeordner (Standard ${OUTPUT_DIR})
  --settings <datei>  Einstellungen für Discord und Clips nach der Auswertung
                   (Standard ${SETTINGS_FILE}, wird nach jedem Stream neu gelesen)
`;

async function main() {
  const { values } = parseArgs({
    options: {
      grace: { type: "string" },
      "max-gap": { type: "string" },
      out: { type: "string", default: OUTPUT_DIR },
      settings: { type: "string", default: SETTINGS_FILE },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const opts = defaultRecorderOptions(values.out!, defaultOptions);
  if (values.grace !== undefined) opts.graceMs = Math.max(0, Number(values.grace) || 0) * 60_000;
  if (values["max-gap"] !== undefined) opts.maxGapSeconds = Number(values["max-gap"]) > 0 ? Number(values["max-gap"]) : Infinity;

  const service = await startLive({
    ...opts,
    // Ohne gültige Anmeldung beenden, damit systemd/journalctl den Fehler zeigt
    onFatal: () => process.exit(1),
    onFinished: async (result, log) => runAutomation(result, await loadAutomation(values.settings!), log, values.out!),
  });

  const shutdown = () => service.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
