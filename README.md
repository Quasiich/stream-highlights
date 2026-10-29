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
   Browser (http://localhost:4777). Das Konsolenfenster minimiert sich danach
   von selbst in die Taskleiste. Nicht schließen, solange du das Programm
   nutzt: Beendet wird es mit **Strg+C** in diesem Fenster oder durch
   Schließen des Fensters. Wer das Fenster lieber offen sieht, startet die
   .exe mit `--no-minimize`. Aus einem bereits offenen Terminal (cmd,
   PowerShell …) gestartet, bleibt dessen Fenster, wie es ist, und das Fenster
   sagt, warum. In Windows Terminal, das die .exe als
   Tab in einem vorhandenen Fenster öffnet, wird dieses ganze Fenster
   minimiert.
3. VOD-Link einfügen und auf **Analysieren** klicken.

Beim ersten Mal lädt das Programm automatisch `TwitchDownloaderCLI` aus dem
[offiziellen GitHub-Release](https://github.com/lay295/TwitchDownloader/releases)
in denselben Ordner (ca. 50 MB). Danach geht es ohne diesen Schritt.

In der Oberfläche siehst du alle Highlights mit Vorschau: Ein Klick auf ein
Highlight spielt die Stelle im eingebetteten Twitch-Player ab. Links stehen
alle bisherigen Analysen. Über **Mit Twitch verbinden** oben rechts
richtest du die [Streamer-Marker](#streamer-marker-optional) ein.

Bist du mit Twitch verbunden, zeigt der Reiter **Deine VODs** links deine
letzten 5 Streams, **Ältere laden** holt jeweils 3 weitere. Ein Klick auf ein
schon analysiertes VOD (✓ Analysiert) öffnet das Ergebnis, bei allen anderen
landet der Link im Eingabefeld, sodass du vor dem Start noch die
Einstellungen anpassen kannst.

Optional kann das Programm den Chat auch während deiner Streams mitschreiben
und direkt nach dem Stream auswerten, siehe
[Live-Mitschnitt](#live-mitschnitt-optional).

Die Datei ist nicht signiert, deshalb kann Windows beim ersten Start „Der
Computer wurde durch Windows geschützt“ anzeigen. Dann auf „Weitere
Informationen“ → „Trotzdem ausführen“ klicken.

### Updates

Beim Start fragt das Programm bei GitHub nach, ob es eine neuere Version
gibt. Wenn ja, erscheint oben in der Oberfläche ein farbiger Balken
„Update verfügbar“, und neben dem Programmnamen steht die installierte
Version hervorgehoben. Installiert wird nie von selbst, sondern erst mit
**Jetzt aktualisieren**:

- Die neue .exe wird aus dem
  [Release](https://github.com/Quasiich/stream-highlights/releases/latest)
  geladen und anhand der Prüfsumme (SHA-256), die GitHub zu jeder Datei
  angibt, geprüft. Stimmt sie nicht oder bricht der Download ab, läuft die
  bisherige Version unverändert weiter.
- Danach startet das Programm neu, die offene Seite lädt von selbst neu.
  Analysen, Einstellungen und Twitch-Verbindung bleiben erhalten.
- Die bisherige Version bleibt für den Notfall als
  `stream-highlights.old.exe` im selben Ordner (beim nächsten Update wird sie
  ersetzt). Links unten in der Oberfläche steht, welche Version das ist; mit
  **Löschen** daneben lässt sie sich entfernen, wenn du den Platz brauchst.
  Macht die neue Version Probleme: Programm schließen,
  `stream-highlights.exe` löschen und `stream-highlights.old.exe` in
  `stream-highlights.exe` umbenennen.
- Solange ein Live-Mitschnitt läuft (Stream aktiv oder Auswertung nach dem
  Stream) oder eine Analyse läuft, ist der Knopf gesperrt, mit Hinweis
  warum. Ist der Live-Mitschnitt nur eingeschaltet und gerade kein Stream
  aktiv, geht das Update; der Mitschnitt ist nach dem Neustart wieder an.

Mit `npm start` aus dem Quellcode gibt es nur den Hinweis, aktualisiert wird
dort mit `git pull` und `npm install`.

### Die .exe selbst bauen

Dafür braucht es einmalig Node.js 26 oder neuer (https://nodejs.org, LTS).
Im Projektordner:

```
npm install
npm run build:exe
```

Das Ergebnis liegt in `dist/stream-highlights.exe`. Die Web-Oberfläche und
die Version aus `package.json` sind darin enthalten. Zum Testen des Updates
lässt sich eine andere Version einbauen, z. B. mit
`BUILD_VERSION=1.0.0 npm run build:exe` (in PowerShell vorher
`$env:BUILD_VERSION="1.0.0"`).

Für ein neues Release: Version in `package.json` erhöhen
(`npm version 1.2.0 --no-git-tag-version`), committen und pushen, die .exe
bauen und ein GitHub-Release mit dem Tag `v1.2.0` anlegen, an das genau die
Datei `stream-highlights.exe` angehängt ist. Nur so finden ältere Versionen
das Update.

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

### Mit Twitch verbinden

Einmalig, dauert eine Minute:

1. In der Oberfläche oben rechts auf **Mit Twitch verbinden** und dann auf
   **Verbinden** klicken.
2. Es öffnet sich https://www.twitch.tv/activate und das Programm zeigt einen
   kurzen Code an. Melde dich dort mit **dem Konto des Kanals** an, dessen
   VODs du analysieren willst, gib den Code ein und bestätige.
3. Oben rechts steht dann „Verbunden als …“.

Ohne Oberfläche geht dasselbe im Projektordner mit `npm run login`.

Das Programm bekommt dabei nur Leserechte: `user:read:broadcast` für deine
Stream-Marker und Kanal-Einstellungen, `user:read:chat` für den
[Live-Mitschnitt](#live-mitschnitt-optional) deines
Chats. Es kann nichts ändern und nichts in den Chat schreiben. Die
Anmeldung landet in `.twitch-auth.json` im Programmordner. Die Datei wird
nicht auf GitHub hochgeladen. Gib sie auch sonst nicht weiter. Das Programm
erneuert die Anmeldung selbst. Erst wenn es 30 Tage nicht benutzt wurde,
musst du dich erneut verbinden. Über **Trennen** oben rechts wird die
Anmeldung gelöscht.

#### Eigene Twitch-App (optional)

Standardmäßig nutzt das Programm die gemeinsame Twitch-App von
stream-highlights. Wer lieber eine eigene App verwenden will, registriert sie
auf https://dev.twitch.tv/console/apps (dafür ist 2FA im Twitch-Konto nötig):
eindeutiger Name, OAuth-Redirect-URL `http://localhost:3000`, Kategorie
„Application Integration“, Client-Typ **„Öffentlich“**. Die Client-ID trägt
man dann beim Verbinden unter „Eigene Twitch-App verwenden“ ein, oder
`npm run login -- --client-id DEINE_CLIENT_ID`, oder setzt die
Umgebungsvariable `TWITCH_CLIENT_ID`.

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

## Live-Mitschnitt (optional)

Statt den Chat nach dem Stream herunterzuladen, kann stream-highlights ihn
während deines Streams über den offiziellen Weg von Twitch
([EventSub](https://dev.twitch.tv/docs/eventsub/)) mitschreiben und direkt
nach dem Stream-Ende selbst auswerten. Das ist eine Zusatzfunktion: Die
Auswertung selbst ist dieselbe wie beim Analysieren eines VODs, und wer den
Mitschnitt nicht einschaltet, merkt davon nichts.

Es gibt zwei Wege, je nachdem, wo das Programm laufen soll:

- **Auf deinem PC (stream-highlights.exe):** In der Oberfläche links unter
  **Live-Mitschnitt** den Haken setzen. Dafür musst du mit Twitch verbunden
  sein. Der Mitschnitt läuft, solange das Programm offen ist, also am besten
  vor dem Stream starten und erst nach der Auswertung schließen. Die
  Einstellung wird gemerkt (`settings.json` im Programmordner) und gilt beim
  nächsten Start wieder. Die Schwellen und erweiterten Einstellungen, die beim
  Einschalten eingetragen sind, gelten auch für die automatischen
  Auswertungen.
- **Auf einem Server (z. B. VPS), ohne dass dein PC laufen muss:**
  `npm run live`, siehe [unten](#auf-einem-server).

Ablauf:

- Geht dein Kanal live (`stream.online`), landet jede Chat-Nachricht sowie
  jeder Sub, Raid und Cheer laufend in `output/live/<Stream-ID>.jsonl`.
- Nach dem Stream-Ende (`stream.offline`) wartet das Programm 10 Minuten,
  falls der Stream nur kurz abgebrochen ist. Geht er in der Zeit weiter, wird
  einfach weitergeschrieben.
- Danach sucht es das VOD zum Stream, schreibt den Chat nach
  `output/<VOD-ID>/chat.json` und analysiert wie gewohnt, inklusive
  Streamer-Markern. Das Ergebnis erscheint unter „Analysen“. Ohne
  gespeichertes VOD heißt der Ordner wie die Stream-ID.
- Wird das Programm mitten im Stream geschlossen und wieder gestartet oder
  verliert es die Verbindung, setzt es den Mitschnitt fort. Fehlen dadurch
  insgesamt mehr als 2 Minuten, lädt es nach dem Stream stattdessen den
  vollständigen Chat per TwitchDownloaderCLI. Endete ein Stream, während das
  Programm nicht lief, wird der Mitschnitt beim nächsten Start ausgewertet.

Erneuert ein Programm das Twitch-Token, wird das alte ungültig. Deshalb nicht
dieselbe `.twitch-auth.json` gleichzeitig auf dem Server und am PC verwenden,
sondern auf beiden getrennt anmelden. Den Mitschnitt nur an einer Stelle
einschalten, sonst wird jeder Stream doppelt ausgewertet.

### Auf einem Server

Voraussetzungen: Node.js 26, `npm install` und einmal `npm run login` im
Projektordner. Die Anmeldung per Gerätecode klappt auch ohne Browser auf dem
Server: Code am eigenen Rechner auf twitch.tv/activate eingeben. Dann:

```
npm run live
```

Optionen: `--grace 5` (Wartezeit nach Stream-Ende in Minuten), `--max-gap 300`
(ab wie vielen fehlenden Sekunden der Chat komplett geladen wird, `0` = nie),
`--out <ordner>`.

Als Dienst (systemd): Eine Vorlage liegt in
`deploy/stream-highlights-live.service`. Pfad (`/opt/stream-highlights`) und
Benutzer (`streamhl`) anpassen, dann:

```
sudo cp deploy/stream-highlights-live.service /etc/systemd/system/
sudo systemctl enable --now stream-highlights-live
journalctl -u stream-highlights-live -f
```

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
