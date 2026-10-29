import { parseArgs } from "node:util";
import { AUTH_FILE, loadAuth, login, saveAuth } from "./twitch.ts";

const usage = `Verwendung:
  npm run login -- --client-id <Client-ID deiner Twitch-App>

Meldet dich mit deinem Streamer-Konto bei Twitch an, damit beim Analysieren
deine Stream-Marker mitgeladen werden. Einrichtung siehe README.
Die Client-ID wird gespeichert; bei einer erneuten Anmeldung reicht \`npm run login\`.
`;

async function main() {
  const { values } = parseArgs({ options: { "client-id": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(usage);
    return;
  }

  const clientId = values["client-id"] ?? process.env.TWITCH_CLIENT_ID ?? (await loadAuth())?.clientId;
  if (!clientId) {
    console.log(usage);
    process.exit(1);
  }

  const auth = await login(clientId);
  await saveAuth(auth);
  console.log(`Angemeldet als ${auth.login ?? "?"}. Gespeichert in ${AUTH_FILE}.`);
  console.log("Ab jetzt lädt `npm run analyze` bei VODs dieses Kanals automatisch die Stream-Marker.");
}

main().catch((err) => {
  console.error(`Fehler: ${err.message}`);
  process.exit(1);
});
