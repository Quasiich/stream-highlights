import { spawn } from "node:child_process";

/**
 * Programme, aus denen heraus die .exe in einem schon offenen Terminal läuft.
 * Dann bleibt das Fenster, wie es ist. Alles andere (Explorer per Doppelklick,
 * Verknüpfung, Startmenü, Stream Deck …) bekommt ein eigenes Fenster, das
 * minimiert werden darf.
 */
const SHELLS = ["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "wsl", "node", "nu", "fish", "tcc", "far"];

/** Wurde die .exe aus einem offenen Terminal gestartet? (Prozessname ohne .exe) */
export function isShell(parentName: string | undefined): boolean {
  return SHELLS.includes(String(parentName ?? "").toLowerCase().replace(/\.exe$/, ""));
}

// Läuft in einer kurzen PowerShell, die am selben Konsolenfenster hängt wie
// die .exe. Sie schaut nach, wer die .exe gestartet hat, und minimiert das
// Fenster nur, wenn das kein Terminal war. Ausgabe: "minimized" oder
// "skipped:<Programm>". Früher wurde stattdessen gezählt, wie viele Prozesse am
// Fenster hängen; das ging schief, sobald zufällig ein kurzer Hilfsprozess lief.
function script(parentPid: number, force: boolean): string {
  return `
$parent = (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue).ProcessName
$shells = @(${SHELLS.map((s) => `'${s}'`).join(",")})
if (-not ${force ? "$true" : "$false"} -and $parent -and ($shells -contains $parent.ToLower())) { "skipped:$parent"; exit }
Add-Type -Name Win -Namespace StreamHighlights -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
'@
[void][StreamHighlights.Win]::ShowWindow([StreamHighlights.Win]::GetConsoleWindow(), 6)
"minimized"
`;
}

/**
 * Minimiert unter Windows das Konsolenfenster der .exe, sobald die Oberfläche
 * im Browser offen ist, außer sie wurde aus einem offenen Terminal gestartet.
 * `force` (nach einem Update) minimiert immer: Dann stammt das Fenster ohnehin
 * von der vorherigen Version. Schlägt etwas fehl, bleibt das Fenster offen.
 */
export function minimizeOwnConsole(force = false): void {
  if (process.platform !== "win32") return;
  // Kein windowsHide und kein detached: Die PowerShell muss am selben
  // Konsolenfenster hängen, sonst findet sie es nicht.
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script(process.ppid, force), "utf16le").toString("base64")],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", () => {
    const skipped = out.match(/skipped:(\S+)/);
    if (skipped) console.log(`Fenster bleibt offen, weil das Programm aus ${skipped[1]} gestartet wurde.`);
  });
  child.on("error", () => {});
}
