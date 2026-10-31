/**
 * Einrichtung vorab: Lädt, was die eingeschalteten Funktionen brauchen
 * (TwitchDownloaderCLI, ffmpeg, Whisper, Modell), und baut einmal eine
 * Verbindung über TwitchDownloaderCLI auf. So fragen Firewall oder
 * Virenschutz nach der Erlaubnis, solange jemand am PC ist (beim Einschalten
 * des Live-Mitschnitts oder über "Jetzt einrichten"), und nicht erst nach
 * dem Stream, wenn niemand antworten kann.
 */
import { checkTwitchDownloaderNetwork, ensureFfmpeg, ensureTwitchDownloader, findFfmpeg, findTwitchDownloader } from "./tools.ts";
import { WHISPER_MODELS, type WhisperModel } from "./voice.ts";
import { prepareVoiceTools, voiceToolsReady } from "./whisper.ts";

export interface SetupNeeds {
  /** Sprach-Auswertung mit diesem Modell, falls eingeschaltet */
  voice?: WhisperModel;
  /** Clips schneiden */
  clips: boolean;
}

export interface SetupItem {
  id: "downloader" | "ffmpeg" | "whisper" | "model" | "network";
  label: string;
  ready: boolean;
}

/** Ob der Verbindungstest in diesem Programmlauf geklappt hat (danach ändert sich das selten) */
let networkOk = false;

export function needsAnything(needs: SetupNeeds): boolean {
  return Boolean(needs.voice) || needs.clips;
}

/** Was gebraucht wird und was davon schon da ist */
export async function setupItems(needs: SetupNeeds): Promise<SetupItem[]> {
  if (!needsAnything(needs)) return [];
  const items: SetupItem[] = [
    { id: "downloader", label: "TwitchDownloaderCLI", ready: Boolean(findTwitchDownloader()) },
    { id: "ffmpeg", label: "ffmpeg", ready: Boolean(findFfmpeg()) },
  ];
  if (needs.voice) {
    const ready = await voiceToolsReady(needs.voice);
    const m = WHISPER_MODELS[needs.voice];
    items.push({ id: "whisper", label: "Whisper", ready: ready.whisper });
    items.push({ id: "model", label: `Modell „${m.label}“ (${m.sizeMb} MB)`, ready: ready.model });
  }
  items.push({ id: "network", label: "Internetzugriff von TwitchDownloaderCLI", ready: networkOk });
  return items;
}

/**
 * Lädt alles Fehlende und prüft die Verbindung. `videoId` ist ein beliebiges
 * VOD für den Verbindungstest; ohne wird er übersprungen. Wirft bei Problemen
 * (bei blockiertem Internet einen NetworkBlockedError mit Hinweis).
 */
export async function runSetup(
  needs: SetupNeeds,
  onProgress: (message: string, percent?: number) => void,
  videoId?: string,
): Promise<{ networkChecked: boolean }> {
  if (!needsAnything(needs)) return { networkChecked: false };
  const downloader = await ensureTwitchDownloader(onProgress);
  await ensureFfmpeg(downloader, onProgress);
  if (needs.voice) await prepareVoiceTools(needs.voice, (p) => onProgress(p.message, p.percent));
  if (!videoId) return { networkChecked: false };
  onProgress("Prüfe den Internetzugriff von TwitchDownloaderCLI …");
  await checkTwitchDownloaderNetwork(downloader, videoId);
  networkOk = true;
  return { networkChecked: true };
}
