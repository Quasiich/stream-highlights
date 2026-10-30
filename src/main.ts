import { dirname } from "node:path";
import * as sea from "node:sea";
import { minimizeOwnConsole } from "./console.ts";
import { openUrl, PORT, readHtmlFromDisk, restoreLive, shutdownLive, startServer } from "./server.ts";
import { checkForUpdate, COMMIT, VERSION } from "./update.ts";

/** Nach einem Update: so lange auf den Port warten, bis die alte Version ihn freigegeben hat */
const UPDATE_PORT_WAIT_MS = 15_000;

/** Tasten zum Beenden im Terminal; auf dem Mac kopiert ⌘C nur, beendet wird mit ⌃C */
const STOP_KEYS = process.platform === "darwin" ? "control+C (⌃C, nicht ⌘C)" : "Strg+C";

/**
 * Startpunkt der Web-Oberfläche, sowohl für `npm start` als auch für die
 * stream-highlights.exe. Die .exe arbeitet in ihrem eigenen Ordner: Dort
 * landen output/, die Twitch-Anmeldung und TwitchDownloaderCLI.
 */
async function main() {
  const packaged = sea.isSea();
  if (packaged) process.chdir(dirname(process.execPath));
  const html = packaged ? async () => sea.getAsset("index.html", "utf8") : readHtmlFromDisk;
  // --port 4778 z. B. für eine zweite Instanz neben einer laufenden
  const portArg = process.argv.indexOf("--port");
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) || PORT : PORT;
  const url = `http://localhost:${port}`;
  // Von der vorherigen Version nach einem Update gestartet: Die Oberfläche ist schon offen.
  const updated = process.argv.includes("--updated");

  try {
    await listenWithRetry(html, port, updated ? UPDATE_PORT_WAIT_MS : 0);
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      // Läuft schon (z. B. doppelt gestartet): einfach die Seite öffnen.
      console.log(`stream-highlights läuft bereits: ${url}`);
      if (!process.argv.includes("--no-open") && !updated) openUrl(url);
      return;
    }
    throw err;
  }

  // Version für die Fehlersuche: im Fenstertitel (auch in der Taskleiste) und als erste Zeile
  process.title = `stream-highlights v${VERSION}`;
  console.log(`stream-highlights v${VERSION} (Build ${COMMIT})${updated ? ", gerade aktualisiert" : ""}`);
  console.log("Läuft.");
  console.log(`Oberfläche: ${url}`);
  console.log("Dieses Fenster offen lassen, solange du das Programm nutzt.");
  console.log(`Beenden: hier ${STOP_KEYS} drücken oder das Fenster schließen.`);
  // Nach einem Update ist die Oberfläche schon offen (es kommt auch --no-open mit)
  const openBrowser = !process.argv.includes("--no-open") && !updated;
  if (openBrowser) openUrl(url);
  // Das Fenster wird nur gebraucht, um das Programm zu beenden: aus dem Weg damit.
  if (packaged && (openBrowser || updated) && !process.argv.includes("--no-minimize")) minimizeOwnConsole(updated);

  // Live-Mitschnitt sauber schließen; SIGHUP kommt unter Windows beim Schließen des Fensters.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdownLive().finally(() => process.exit(0)));
  }

  void checkForUpdate().then((info) => {
    if (info.available) console.log(`Neue Version ${info.latest} verfügbar. In der Oberfläche auf „Jetzt aktualisieren“ klicken.`);
  });
  await restoreLive();
}

async function listenWithRetry(html: () => Promise<string>, port: number, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await startServer(html, port);
      return;
    } catch (err: any) {
      if (err.code !== "EADDRINUSE" || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exitCode = 1;
  // Per Doppelklick gestartet würde sich das Fenster sonst sofort schließen.
  if (sea.isSea()) {
    console.error("Zum Schließen Enter drücken.");
    process.stdin.once("data", () => process.exit(1));
  }
});
