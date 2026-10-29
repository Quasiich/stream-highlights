# stream-highlights

Findet die spannendsten Stellen eines Twitch-VODs anhand des Chats und gibt
sie als Liste mit direkten Links aus. Stellen, die der Streamer während des
Streams per Hotkey markiert hat, werden immer übernommen (siehe
[Streamer-Marker](#streamer-marker-optional)).

## Schnellstart: stream-highlights.exe

Der einfachste Weg, ganz ohne Installation:

1. `stream-highlights.exe` in einen eigenen Ordner legen, z. B.
   `Dokumente\stream-highlights`. Dort landen später auch die Ergebnisse.
2. Doppelklicken. Es öffnet sich ein Konsolenfenster und die Oberfläche im
   Browser (http://localhost:4777). Das Konsolenfenster offen lassen; wird
   es geschlossen, beendet sich das Programm.
3. VOD-Link einfügen und auf **Analysieren** klicken.

Beim ersten Mal lädt das Programm automatisch `TwitchDownloaderCLI` aus dem
[offiziellen GitHub-Release](https://github.com/lay295/TwitchDownloader/releases)
in denselben Ordner (ca. 50 MB). Danach geht es ohne diesen Schritt.

In der Oberfläche siehst du alle Highlights mit Vorschau: Ein Klick auf ein
Highlight spielt die Stelle im eingebetteten Twitch-Player ab. Links stehen
alle bisherigen Analysen. Über **Mit Twitch verbinden** oben rechts
richtest du die [Streamer-Marker](#streamer-marker-optional) ein.

Die Datei ist nicht signiert, deshalb kann Windows beim ersten Start „Der
Computer wurde durch Windows geschützt“ anzeigen. Dann auf „Weitere
Informationen“ → „Trotzdem ausführen“ klicken.

### Die .exe selbst bauen

Dafür braucht es einmalig Node.js 26 oder neuer (https://nodejs.org, LTS).
Im Projektordner:

```
npm install
npm run build:exe
```

Das Ergebnis liegt in `dist/stream-highlights.exe`. Die Web-Oberfläche ist
darin enthalten.

## Für Entwickler: Kommandozeile

Mit installiertem Node.js (26 oder neuer) und `npm install` im Projektordner:

```
npm start
```

startet dieselbe Oberfläche direkt aus dem Quellcode. Ohne Oberfläche geht es
so:

```
npm run analyze -- https://www.twitch.tv/videos/2912392719
```

Das lädt den Chat (beim ersten Mal ein paar Minuten), sucht die Peaks und
schreibt das Ergebnis nach `output/<VOD-ID>/`:

- `highlights.md`: Tabelle mit klickbaren Zeitstempeln, darunter separat
  Gift-Bomben ab 5 Subs, Raids ab 10 Zuschauern und Cheers ab 500 Bits
  (plus Summen; Resubs werden weggelassen). Die Schwellen lassen sich in der
  Oberfläche vor dem Start einstellen.
- `highlights.json`: dieselben Daten für die nächsten Pipeline-Schritte
- `chat.json`: der Chat, wird beim nächsten Lauf wiederverwendet

Optionen: `--top 15` (mehr Chat-Treffer), `--bucket 20` (feinere Fenster),
`--gap 60` (Highlights dürfen näher beieinander liegen), `--marker-lead 90`
(mehr Vorlauf vor Streamer-Markern), `--min-gifts 10 --min-raid 50 --min-bits 1000`
(Schwellen für die Liste der Gift-Bomben, Raids und Cheers).

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
4. **Verbinden:** In der Oberfläche oben rechts auf **Mit Twitch verbinden**
   klicken, die Client-ID einfügen und auf „Weiter“ klicken. Es öffnet sich
   https://www.twitch.tv/activate und das Programm zeigt einen kurzen Code an.
   Melde dich dort mit **dem Konto des Kanals** an, dessen VODs du analysieren
   willst, gib den Code ein und bestätige. Oben rechts steht dann
   „Verbunden als …“.

   Ohne Oberfläche geht dasselbe im Projektordner mit
   `npm run login -- --client-id DEINE_CLIENT_ID`.

Die Anmeldung landet in `.twitch-auth.json` im Programmordner. Die Datei wird
nicht auf GitHub hochgeladen. Gib sie auch sonst nicht weiter, denn sie
erlaubt das Lesen deiner Kanal-Einstellungen. Das Programm erneuert die
Anmeldung selbst. Erst wenn es 30 Tage nicht benutzt wurde, musst du dich
erneut verbinden (die Client-ID ist dann schon eingetragen). Über
**Trennen** oben rechts wird die Anmeldung gelöscht.

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
