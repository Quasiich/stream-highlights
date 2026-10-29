# stream-highlights

Findet die spannendsten Stellen eines Twitch-VODs anhand des Chats und gibt
sie als Liste mit direkten Links aus.

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

- `highlights.md`: Tabelle mit klickbaren Zeitstempeln
- `highlights.json`: dieselben Daten für die nächsten Pipeline-Schritte
- `chat.json`: der Chat, wird beim nächsten Lauf wiederverwendet

Optionen: `--top 15` (mehr Treffer), `--bucket 20` (feinere Fenster),
`--gap 60` (Highlights dürfen näher beieinander liegen).

Eine vorhandene Chat-Datei geht auch direkt: `npm run analyze -- chat.json`.

## So wird bewertet

- Der Stream wird in 30-Sekunden-Fenster geteilt.
- Pro Fenster zählen: verschiedene Chatter (am stärksten), Nachrichten,
  Hype-Emotes und Lachen (KEKW, LUL, POG, hahaha, xD, ???, …), Subs/Raids/Bits.
- Eine Person zählt pro Fenster mit höchstens 3 Nachrichten (Spam-Schutz).
- Verglichen wird mit dem Median der umliegenden ±5 Minuten, damit ruhige
  und lebhafte Phasen des Streams fair behandelt werden.
- Der Clip beginnt 45 s vor dem Peak, weil der Chat erst reagiert, nachdem
  etwas passiert ist.

## Entwicklung

```
npm test
npm run typecheck
```
