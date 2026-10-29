import { spawn } from "node:child_process";

// Läuft in einer kurzen PowerShell, die am selben Konsolenfenster hängt wie
// die .exe. GetConsoleProcessList zählt alle Prozesse an diesem Fenster: nur
// die .exe und diese PowerShell heißt "per Doppelklick gestartet". Hängen mehr
// dran (cmd, PowerShell, npm …), wurde aus einem offenen Terminal gestartet,
// und das Fenster bleibt, wie es ist.
const SCRIPT = `
Add-Type -Name Win -Namespace StreamHighlights -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] list, uint count);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
'@
$list = New-Object 'uint32[]' 16
if ([StreamHighlights.Win]::GetConsoleProcessList($list, 16) -le 2) {
  [void][StreamHighlights.Win]::ShowWindow([StreamHighlights.Win]::GetConsoleWindow(), 6)
}
`;

/**
 * Minimiert unter Windows das Konsolenfenster der .exe, sobald die Oberfläche
 * im Browser offen ist. Nur wenn das Fenster der .exe allein gehört (Start per
 * Doppelklick), nie ein Terminal, aus dem sie gestartet wurde. Schlägt das
 * fehl, bleibt das Fenster einfach offen.
 */
export function minimizeOwnConsole(): void {
  if (process.platform !== "win32") return;
  // Kein windowsHide und kein detached: Die PowerShell muss am selben
  // Konsolenfenster hängen, sonst findet sie es nicht.
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(SCRIPT, "utf16le").toString("base64")],
    { stdio: "ignore" },
  );
  child.on("error", () => {});
}
