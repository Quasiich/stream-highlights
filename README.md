# stream-highlights

Findet die spannendsten Stellen eines Twitch-VODs anhand des Chats und gibt
sie als Liste mit direkten Links aus. Stellen, die der Streamer während des
Streams per Hotkey markiert hat, werden immer übernommen (siehe
[Streamer-Marker](#streamer-marker-optional)).

## Einrichtung (Windows-PC, einmalig)

1. **Node.js 20 oder neuer** installieren: https://nodejs.org (LTS).
2. **TwitchDownloaderCLI** herunterladen: https://github.com/lay295/TwitchDownloader/releases
   → `TwitchDownloaderCLI-…-Windows-x64.zip`, entpacken und die
   `TwitchDownloaderCLI.exe` direkt in diesen Projektordner legen.
3. Im Projektordner:
   ```
   npm install
   ```

## Benutzung

```
npm run analyze -- https://www.twitch.tv/videos/2912392719
```

Das lädt den Chat (beim ersten Mal ein paar Minuten), sucht die Peaks und
schreibt das Ergebnis nach `output/<VOD-ID>/`:

- `highlights.md`: Tabelle mit klickbaren Zeitstempeln, darunter separat
  Gift-Bomben ab 5 Subs, Raids ab 10 Zuschauern und Cheers ab 500 Bits
  (plus Summen; Resubs werden weggelassen)
- `highlights.json`: dieselben Daten für die nächsten Pipeline-Schritte
- `chat.json`: der Chat, wird beim nächsten Lauf wiederverwendet

Optionen: `--top 15` (mehr Chat-Treffer), `--bucket 20` (feinere Fenster),
`--gap 60` (Highlights dürfen näher beieinander liegen), `--marker-lead 90`
(mehr Vorlauf vor Streamer-Markern).

Eine vorhandene Chat-Datei geht auch direkt: `npm run analyze -- chat.json`.

## Streamer-Marker (optional)

Als Streamer kannst du während des Streams per Hotkey Stellen markieren, die
auf jeden Fall in die Highlights sollen. Das Programm nutzt dafür die
eingebaute **Stream-Marker**-Funktion von Twitch: Die Marker werden am VOD
gespeichert und beim Analysieren über die Twitch-API abgerufen.

### Einmalig einrichten

Das musst du als Streamer selbst erledigen. Es dauert etwa 5 Minuten.

1. **Zwei-Faktor-Authentifizierung** für dein Twitch-Konto einschalten
   (Twitch → Einstellungen → Sicherheit und Privatsphäre). Ohne 2FA lässt
   Twitch dich keine App registrieren.
2. **Twitch-App registrieren:** https://dev.twitch.tv/console/apps öffnen,
   mit deinem Twitch-Konto anmelden und auf „Ihre Anwendung registrieren“
   klicken. Ausfüllen:
   - **Name:** beliebig, muss aber auf Twitch eindeutig sein, z. B.
     `stream-highlights-<dein-kanal>`
   - **OAuth-Redirect-URLs:** `http://localhost:3000` eintragen und auf
     „Hinzufügen“ klicken (wird nicht benutzt, Twitch verlangt aber einen
     Eintrag)
   - **Kategorie:** z. B. „Application Integration“
   - **Client-Typ:** „Öffentlich“, falls gefragt
3. Nach „Erstellen“ bei der App auf **„Verwalten“** klicken und die
   **Client-ID** kopieren. Ein Client-Secret brauchst du nicht.
4. Im Projektordner anmelden:
   ```
   npm run login -- --client-id DEINE_CLIENT_ID
   ```
   Das Programm zeigt einen kurzen Code an. Öffne https://www.twitch.tv/activate,
   melde dich dort mit **dem Konto des Kanals** an, dessen VODs du analysieren
   willst, gib den Code ein und bestätige. Das Programm meldet dann
   „Angemeldet als …“.

Die Anmeldung landet in `.twitch-auth.json` im Projektordner. Die Datei wird
nicht auf GitHub hochgeladen. Gib sie auch sonst nicht weiter, denn sie
erlaubt das Lesen deiner Kanal-Einstellungen. Das Programm erneuert die
Anmeldung selbst. Erst wenn es 30 Tage nicht benutzt wurde, ist erneut
`npm run login` nötig (die Client-ID ist dann schon gespeichert).

### Marker im Stream setzen

Für Marker gibt es bei Twitch mehrere Wege:

- **Stream Deck:** Im Twitch-Plugin gibt es eine Aktion „Stream-Marker“. Leg
  sie auf eine Taste, und du hast einen Hotkey.
- **Chat:** `/marker` oder `/marker Boss besiegt` in deinen eigenen Chat
  schreiben. Die Zuschauer sehen den Befehl nicht. Auch deine Editoren können
  so Marker setzen.
- **Stream-Manager:** Schnellaktion „Stream-Marker hinzufügen“.

Twitch speichert Marker nur, wenn du **live** bist (keine Premieren oder
Reruns) und unter Einstellungen → Stream **„Vergangene Übertragungen
speichern“** eingeschaltet ist.

Drück den Marker ruhig erst, nachdem der Moment passiert ist: Der Clip beginnt
60 Sekunden vor dem Marker und endet 30 Sekunden danach. Den Vorlauf kannst
du mit `--marker-lead` ändern. Eine Beschreibung wie „Boss besiegt“ erscheint
später in der Highlight-Liste.

### Was beim Analysieren passiert

- Bei VODs deines Kanals werden die Marker automatisch mitgeladen
  („3 Streamer-Marker geladen.“).
- Jeder Marker wird ein Highlight und steht oben in der Liste, mit ★
  gekennzeichnet. `--top` begrenzt nur die zusätzlichen Chat-Highlights.
- Reagiert der Chat zur selben Zeit, werden Marker und Chat-Peak zu einem
  Clip zusammengeführt („★ Marker + Chat“).
- In `highlights.json` steht bei jedem Highlight unter `source`, woher es
  kommt (`marker`, `chat` oder `marker+chat`), unter `markers` stehen die
  Beschreibungen.
- Ohne Anmeldung, oder bei VODs anderer Kanäle (Twitch gibt Marker nur an den
  eigenen Kanal heraus), läuft alles wie gewohnt nur mit dem Chat.

## So wird bewertet

- Der Stream wird in 30-Sekunden-Fenster geteilt.
- Pro Fenster zählen: verschiedene Chatter (am stärksten), Nachrichten,
  Hype-Emotes und Lachen (KEKW, LUL, POG, hahaha, xD, ???, …).
- Nicht mit gezählt werden Bot-Befehle (`!50`, `!tb`, …), Nachrichten von
  Chat-Bots (Nightbot, StreamElements, …) sowie Subs, Raids und Bits. Diese
  sagen nichts über den Stream-Inhalt aus und werden separat aufgelistet.
- Füllwörter (das, und, ich, …) erscheinen nicht in der Wortliste.
- Eine Person zählt pro Fenster mit höchstens 3 Nachrichten (Spam-Schutz).
- Liegen zwei Peaks zu nah beieinander oder überlappen ihre Clips, werden sie
  zu einem Clip zusammengeführt.
- Verglichen wird mit dem Median der umliegenden ±5 Minuten, damit ruhige
  und lebhafte Phasen des Streams fair behandelt werden.
- Der Clip beginnt 45 s vor dem Peak, weil der Chat erst reagiert, nachdem
  etwas passiert ist.
- Streamer-Marker gehen allem vor und bekommen 60 s Vorlauf.

## Entwicklung

```
npm test
npm run typecheck
```
