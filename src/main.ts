import { dirname } from "node:path";
import * as sea from "node:sea";
import { openUrl, PORT, readHtmlFromDisk, restoreLive, shutdownLive, startServer } from "./server.ts";

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

  try {
    await startServer(html, port);
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      // Läuft schon (z. B. doppelt gestartet): einfach die Seite öffnen.
      console.log(`stream-highlights läuft bereits: ${url}`);
      if (!process.argv.includes("--no-open")) openUrl(url);
      return;
    }
    throw err;
  }

  console.log("stream-highlights läuft.");
  console.log(`Oberfläche: ${url}`);
  console.log("Dieses Fenster offen lassen. Schließen beendet das Programm.");
  if (!process.argv.includes("--no-open")) openUrl(url);

  // Live-Mitschnitt sauber schließen; SIGHUP kommt unter Windows beim Schließen des Fensters.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => void shutdownLive().finally(() => process.exit(0)));
  }
  await restoreLive();
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
