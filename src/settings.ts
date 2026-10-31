import { readFile, writeFile } from "node:fs/promises";
import type { VoiceOptions } from "./voice.ts";

/** Einstellungen, die einen Neustart überdauern (im Programmordner bzw. Arbeitsordner des Servers) */
export const SETTINGS_FILE = "settings.json";

export interface Settings {
  /** Live-Mitschnitt beim Start einschalten, mit diesen Analyse-Einstellungen */
  live?: { enabled: boolean; options?: Record<string, unknown> };
  /** Zuletzt benutzte Einstellungen für Sprache und Lautstärke */
  voice?: VoiceOptions;
  /** Discord und Clips nach der Auswertung, siehe automation.ts */
  discord?: Record<string, unknown>;
  clips?: Record<string, unknown>;
  /** Ob nach der Live-Auswertung automatisch gepostet oder erst ausgewählt wird */
  publish?: Record<string, unknown>;
}

export async function loadSettings(file = SETTINGS_FILE): Promise<Settings> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

/** Übernimmt die angegebenen Bereiche, alle anderen bleiben, wie sie sind. */
export async function updateSettings(patch: Settings, file = SETTINGS_FILE): Promise<Settings> {
  const settings = { ...(await loadSettings(file)), ...patch };
  await writeFile(file, JSON.stringify(settings, null, 2));
  return settings;
}
