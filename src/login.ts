import { parseArgs } from "node:util";
import { AUTH_FILE, DEFAULT_CLIENT_ID, loadAuth, resolveClientId, startLogin } from "./twitch.ts";

const usage = `Verwendung:
  npm run login [-- --client-id <Client-ID einer eigenen Twitch-App>]

Meldet dich mit deinem Streamer-Konto bei Twitch an, damit beim Analysieren
deine Stream-Marker mitgeladen werden. Ohne --client-id wird die gemeinsame
App von stream-highlights verwendet; eine einmal angegebene eigene
Client-ID wird gespeichert und bei der nächsten Anmeldung wiederverwendet.
`;

async function main() {
  const { values } = parseArgs({ options: { "client-id": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(usage);
    return;
  }

  const saved = (await loadAuth())?.clientId;
  const clientId = resolveClientId(values["client-id"] ?? (saved !== DEFAULT_CLIENT_ID ? saved : undefined));

  const pending = await startLogin(clientId);
  console.log(`Öffne ${pending.verificationUri}`);
  console.log(`und bestätige dort mit deinem Streamer-Konto den Code: ${pending.userCode}`);
  console.log("Warte auf Bestätigung …");
  const auth = await pending.done;
  console.log(`Angemeldet als ${auth.login ?? "?"}. Gespeichert in ${AUTH_FILE}.`);
  console.log("Ab jetzt lädt `npm run analyze` bei VODs dieses Kanals automatisch die Stream-Marker.");
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
