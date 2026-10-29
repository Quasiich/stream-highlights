import { parseArgs } from "node:util";
import { defaultOptions } from "./analyze.ts";
import { connectEventSub } from "./eventsub.ts";
import { OUTPUT_DIR } from "./pipeline.ts";
import { defaultRecorderOptions, LiveRecorder } from "./recorder.ts";
import { AUTH_FILE, CHAT_SCOPE, checkAuth, subscribeEventSub } from "./twitch.ts";

const usage = `Verwendung:
  npm run live [-- Optionen]

Läuft dauerhaft (z. B. als systemd-Dienst auf einem Server), schneidet den
Chat deines Kanals während jedes Streams über Twitch EventSub mit und wertet
ihn nach dem Stream-Ende automatisch aus. Ergebnis wie bei
\`npm run analyze\` in output/<VOD-ID>/. Vorher einmal \`npm run login\`.

Optionen:
  --grace <min>    Nach dem Stream-Ende so lange warten, falls er nur kurz
                   abgebrochen ist (Standard 10)
  --max-gap <s>    Fehlen im Mitschnitt mehr Sekunden, wird der Chat nach dem
                   Stream komplett per TwitchDownloaderCLI geladen
                   (Standard 120, 0 = nie)
  --out <ordner>   Ausgabeordner (Standard ${OUTPUT_DIR})
`;

/** Abgleich mit dem Stream-Status, falls ein online/offline-Ereignis verloren ging */
const SYNC_INTERVAL_MS = 5 * 60_000;
/** Twitch verlangt, das Token mindestens stündlich zu prüfen */
const VALIDATE_INTERVAL_MS = 60 * 60_000;

async function main() {
  const { values } = parseArgs({
    options: {
      grace: { type: "string" },
      "max-gap": { type: "string" },
      out: { type: "string", default: OUTPUT_DIR },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }

  const auth = await checkAuth(AUTH_FILE);
  if (!auth.scopes.includes(CHAT_SCOPE)) {
    throw new Error(`Die Anmeldung darf den Chat nicht lesen (${CHAT_SCOPE} fehlt). Bitte einmal neu anmelden: npm run login`);
  }
  const userId = auth.userId!;

  const opts = defaultRecorderOptions(values.out!, defaultOptions);
  if (values.grace !== undefined) opts.graceMs = Math.max(0, Number(values.grace) || 0) * 60_000;
  if (values["max-gap"] !== undefined) opts.maxGapSeconds = Number(values["max-gap"]) > 0 ? Number(values["max-gap"]) : Infinity;
  const { log } = opts;
  const recorder = new LiveRecorder(userId, auth.login, opts);

  const sync = () => recorder.sync().catch((err) => log(`Abgleich fehlgeschlagen: ${err.message}`));

  const connection = connectEventSub({
    async onSession(sessionId) {
      const broadcaster = { broadcaster_user_id: userId };
      // Nacheinander, damit ein nötiges Token-Refresh nur einmal passiert
      await subscribeEventSub("stream.online", broadcaster, sessionId);
      await subscribeEventSub("stream.offline", broadcaster, sessionId);
      await subscribeEventSub("channel.chat.message", { ...broadcaster, user_id: userId }, sessionId);
      await subscribeEventSub("channel.chat.notification", { ...broadcaster, user_id: userId }, sessionId);
      log(`Verbunden mit Twitch EventSub, warte auf Streams von ${auth.login ?? userId}.`);
      await sync();
    },
    onEvent(type, event, timestamp) {
      recorder.handle(type, event, timestamp).catch((err) => log(`Fehler bei ${type}: ${err.message}`));
    },
    onDisconnect(reason) {
      log(`EventSub getrennt: ${reason}. Verbinde neu …`);
      recorder.disconnected();
    },
    onRevocation(type, status) {
      log(`Twitch hat das Abo ${type} beendet (${status}).`);
      if (status === "authorization_revoked" || status === "user_removed") {
        log("Die Anmeldung wurde widerrufen. Bitte `npm run login` ausführen und den Dienst neu starten.");
        void shutdown(1);
      }
    },
  });

  const timers = [
    setInterval(sync, SYNC_INTERVAL_MS),
    setInterval(
      () => checkAuth(AUTH_FILE).catch((err) => log(`Twitch-Anmeldung: ${err.message}`)),
      VALIDATE_INTERVAL_MS,
    ),
  ];

  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    timers.forEach(clearInterval);
    connection.close();
    await recorder.stop();
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
