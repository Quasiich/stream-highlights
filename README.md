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
  [Release](https://github.com/Quasiich/stream-highlights-releases/releases/latest)
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
bauen und im öffentlichen Repository
[Quasiich/stream-highlights-releases](https://github.com/Quasiich/stream-highlights-releases)
ein Release mit dem Tag `v1.2.0` anlegen, an das genau die Datei
`stream-highlights.exe` angehängt ist. Nur so finden ältere Versionen das
Update:

```
gh release create v1.2.0 dist/stream-highlights.exe --repo Quasiich/stream-highlights-releases --title "v1.2.0" --notes-file notes.md
```

Die Releases liegen dort und nicht im Quellcode-Repository, damit Update-Prüfung
und Download ohne GitHub-Anmeldung funktionieren, auch wenn der Quellcode
privat ist. Versionen bis 1.2.2 suchen Updates noch im Quellcode-Repository;
sie kommen nur weiter, solange dort ein Release mit einer neueren Version
(ab 1.2.3) liegt, das öffentlich erreichbar ist.

## Für Entwickler: Kommandozeile

Mit installiertem Node.js (26 oder neuer) und `npm install` im Projektordner:

```
npm start
```

startet dieselbe Oberfläche direkt aus dem Quellcode. Beendet wird sie im
Terminal mit **Strg+C**, auf dem Mac mit **control+C** (⌃C, nicht ⌘C). Ohne
Oberfläche geht es so:

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

Mit `--clips` werden die Highlights danach als MP4 aus dem VOD geschnitten,
mit `--discord` in Discord gepostet, jeweils mit den Einstellungen aus
`settings.json` (siehe [Nach der Auswertung](#nach-der-auswertung-discord-und-clips)).

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

  Darunter lässt sich **Ton auswerten (Sprache & Lautstärke)** getrennt
  dazuschalten. Das ist derselbe Schalter wie „Sprache & Lautstärke“ bei der
  VOD-Analyse und gilt immer so, wie er gerade steht: Jede Änderung wird
  sofort gespeichert und von der nächsten Auswertung nach Stream-Ende
  übernommen, auch mitten im Stream. Der Ton wird nicht live aufgenommen,
  sondern nach dem Stream aus dem VOD geladen und von Whisper ausgewertet (bei
  einer Nvidia-Karte etwa 2 Minuten pro Stunde Stream). Danach folgen wie
  eingestellt Discord und Clips.

  Während der Auswertung zeigt der Kasten den aktuellen Schritt mit Prozent
  und die geschätzte Restzeit bis alles fertig ist, Clips eingerechnet.
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
`--out <ordner>`, `--settings <datei>` (Discord und Clips, siehe
[unten](#nach-der-auswertung-discord-und-clips)).

Als Dienst (systemd): Eine Vorlage liegt in
`deploy/stream-highlights-live.service`. Pfad (`/opt/stream-highlights`) und
Benutzer (`streamhl`) anpassen, dann:

```
sudo cp deploy/stream-highlights-live.service /etc/systemd/system/
sudo systemctl enable --now stream-highlights-live
journalctl -u stream-highlights-live -f
```

## Sprache & Lautstärke (optional, Whisper)

Zusätzlich zum Chat kann stream-highlights auswerten, was im Stream **gesagt**
wird und wo es **laut** wird. Eingeschaltet wird das in der Oberfläche unter
**Sprache & Lautstärke (Whisper)**; ohne Haken ändert sich nichts.

- **Stichwörter:** Du legst eine Liste fest (eins pro Zeile), z. B.
  `clip das`, `oh mein gott`, `was war das`. Sagt der Streamer eins davon, wird
  die Stelle immer zum Highlight, wie ein Streamer-Marker (40 s Vorlauf, weil
  man es meist erst nach dem Moment sagt). Groß-/Kleinschreibung und
  Satzzeichen spielen keine Rolle, gesucht werden ganze Wörter: `clip` passt
  auf „Clip das“, aber nicht auf „Clipboard“. Mit `*` am Ende passt jede
  Fortsetzung: `clip*` findet auch „clippen“ und „clippt“.
- **Laute Stellen:** Whisper selbst misst keine Lautstärke. Das Programm misst
  deshalb selbst den Pegel jeder Sekunde (Effektivwert in dBFS) und vergleicht
  ihn mit dem Median der umliegenden ±2,5 Minuten. Eine Stelle gilt als laut,
  wenn sie mindestens **x dB lauter** ist als diese Umgebung, und das
  **mindestens y Sekunden** lang (Standard: 12 dB, 2 s). Zur Einordnung:
  +6 dB ist hörbar lauter, +10 bis +12 dB wird etwa als doppelt so laut
  empfunden, +20 dB ist sehr laut. Ein fester Wert („über −10 dB“) würde nicht
  funktionieren, weil jeder Stream anders ausgesteuert ist. Gemessen wird der
  ganze Stream-Ton, also Stimme, Spiel und Musik zusammen.
  Liegt eine laute Stelle bei einem anderen Highlight, wird sie dort vermerkt
  (🔊 +14 dB). Neue Highlights entstehen nur aus den stärksten lauten Stellen
  (Standard: höchstens 5).
- **Was gesagt wurde:** Bei jedem Highlight steht der Text, der in dem Moment
  gesprochen wurde, auch in `highlights.md`.

### Dauer und Fortschritt

Vor dem Start zeigt die Oberfläche, wie lange es voraussichtlich dauert. Das
hängt vor allem von der Länge des Streams, dem Modell und davon ab, ob eine
Nvidia-Grafikkarte da ist. Nach der ersten Auswertung misst das Programm, wie
schnell dein PC tatsächlich ist, und schätzt danach genauer. Während der
Auswertung siehst du je Schritt Prozent und Restzeit sowie die Restzeit bis zum
Ergebnis.

| Genauigkeit | Modell | Größe | Grafikkarte* | Prozessor* |
|---|---|---|---|---|
| Schnell | base | 148 MB | ca. 2 Min. | ca. 20 Min. |
| Ausgewogen (Standard) | small | 488 MB | ca. 4 Min. | ca. 50 Min. |
| Genau | large-v3-turbo | 574 MB | ca. 7 Min. | ca. 2,5 Std. |

\* grobe Startwerte für 3 Stunden Stream; sie werden nach dem ersten Lauf durch
die gemessenen ersetzt.

### Was dabei passiert

1. Beim ersten Mal lädt das Programm in den Ordner `tools/`: Whisper
   ([whisper.cpp](https://github.com/ggml-org/whisper.cpp), mit Nvidia-Karte
   der CUDA-Build), das gewählte Modell und ffmpeg (über TwitchDownloaderCLI).
   Läuft der CUDA-Build auf dem PC nicht, wechselt es von selbst auf den
   Prozessor und merkt sich das.
2. Es lädt nur die **Tonspur** des VODs (ca. 70 MB pro Stunde), wandelt sie
   um, misst die Lautstärke und lässt Whisper laufen.
3. In `output/<VOD-ID>/` bleiben `transcript.json` und `loudness.json` liegen,
   die Ton-Dateien werden gelöscht. Wird dasselbe VOD erneut analysiert, etwa
   mit anderen Stichwörtern oder dB-Werten, dauert das nur Sekunden. Nur ein
   anderes Modell oder eine andere Sprache transkribiert neu.
4. Klappt die Sprach-Auswertung nicht (z. B. kein Internet), gibt es trotzdem
   das normale Ergebnis aus Chat und Markern, mit einem Hinweis.

Die Einstellungen werden bei jeder Änderung gespeichert und gelten sofort
auch für den Live-Mitschnitt.

Kommandozeile: `--voice`, `--model base|small|large-v3-turbo`,
`--language de|en|auto`, `--keywords "clip das,oh mein gott"`, `--loud-db 12`,
`--no-loud`. Außerhalb von Windows gibt es keine fertigen Whisper-Builds: dort
whisper.cpp selbst bauen und `whisper-cli` in den PATH legen (oder
`WHISPER_CLI` auf die Datei setzen); ffmpeg muss installiert sein.

## Nach der Auswertung: Discord und Clips

Optional kann das Programm nach jeder Live-Auswertung automatisch

- **die besten Highlights in einen Discord-Kanal posten**: Zeit mit Link zur
  Stelle im VOD, Länge, Chat-Ausschlag bzw. Streamer-Marker und was der Chat
  geschrieben hat, dazu die Summe der Subs, Raids und Bits.
- **die Highlights als MP4 aus dem VOD schneiden**, ohne den ganzen Stream
  herunterzuladen. Beim ersten Mal lädt TwitchDownloaderCLI dafür ffmpeg in
  den Programmordner (ca. 80 MB).

Eingestellt wird das über **⚙ Einstellungen** oben rechts (oder links unter
**Nach der Auswertung**). Für alle anderen Analysen gibt es im Ergebnis die
Knöpfe **An Discord senden** und **Clips schneiden**, die dieselben
Einstellungen nutzen.

**Discord:**

- **Webhooks:** In Discord den Kanal bearbeiten → Integrationen → Webhooks →
  Neuer Webhook → Webhook-URL kopieren und in den Einstellungen eintragen. Es
  gehen mehrere (z. B. „Mods“ und „Community“), jeder Post geht dann in alle
  Kanäle. **Testnachricht senden** neben jedem Webhook prüft ihn und zeigt
  gleich den eigenen Text mit Beispielwerten. Die URLs wie Passwörter
  behandeln: Wer sie kennt, kann in den Kanal schreiben.
- **Text über den Highlights:** frei wählbar, mit Platzhaltern `{kanal}`,
  `{titel}`, `{anzahl}`, `{gesamt}`, `{datum}` und `{link}`. Standard:
  `Neue Highlights von **{kanal}**: die besten {anzahl} von {gesamt}`.
  Discord-Formatierung wie `**fett**` geht.
- **Highlights im Post:** wie viele der besten Highlights gelistet werden.

Pings wie `@everyone` werden nie ausgelöst, weder aus dem Chat noch aus dem
eigenen Text.

**Clips:**

| Einstellung | Bedeutung | Standard |
|---|---|---|
| Anzahl Clips | Die besten n Highlights, beginnend mit #1 | 5 |
| Länge: wie das erkannte Highlight | Ganzes Highlight plus **Puffer** vorne und hinten. Längere werden um den Peak herum auf **Höchstens** gekürzt. | 5 s Puffer, max. 180 s |
| Länge: feste Länge | Jeder Clip ist **Clip-Länge** lang und beginnt **Davon vor dem Peak** vor dem Streamer-Marker bzw. dem stärksten Chat-Moment | 60 s, davon 45 s vorher |
| Qualität | 1080p, 720p, 480p, 360p oder die beste verfügbare. Die beste ist bei manchen Kanälen 1440p in HEVC, das spielen nicht alle Player und Discord ab. | 1080p |
| Zielordner | Leer: `output/<VOD-ID>/clips/`. Sonst ein Unterordner pro Stream, z. B. `D:\Clips\2026-10-30_2912392719\` | leer |

Die Dateien heißen nach Rang und Startzeit, z. B. `01_28-10.mp4`. Schon
vorhandene Clips werden übersprungen, ein abgebrochener Schnitt lässt sich also
einfach wiederholen.

Gespeichert wird alles in `settings.json` im Programmordner. Auf einem Server
ohne Oberfläche dort eintragen, `npm run live` liest die Datei nach jedem Stream
neu:

```json
{
  "discord": {
    "enabled": true,
    "webhooks": [{ "name": "Mods", "url": "https://discord.com/api/webhooks/…" }],
    "message": "Neue Highlights von **{kanal}**: die besten {anzahl} von {gesamt}",
    "top": 5
  },
  "clips": { "enabled": true, "mode": "highlight", "count": 5, "paddingSeconds": 5, "maxLengthSeconds": 180, "lengthSeconds": 60, "leadSeconds": 45, "quality": "1080p", "dir": "/srv/clips" }
}
```

Über die Kommandozeile geht es mit `npm run analyze -- <VOD> --clips --discord`.

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
- Mit Whisper: Gesagte Stichwörter werden ebenfalls immer Highlights. Laute
  Stellen werden bei vorhandenen Highlights vermerkt und ergeben höchstens 5
  eigene. Fällt etwas zeitlich zusammen, wird es ein Clip mit mehreren Quellen.

## Entwicklung

```
npm test
npm run typecheck
```
