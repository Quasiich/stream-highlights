import { test } from "node:test";
import assert from "node:assert/strict";
import { isShell } from "../src/console.ts";

test("isShell erkennt Terminals, aber nicht Explorer, Verknüpfungen oder Stream Deck", () => {
  for (const shell of ["cmd", "cmd.exe", "powershell", "PowerShell.exe", "pwsh", "bash", "node"]) assert.equal(isShell(shell), true, shell);
  for (const other of ["explorer", "explorer.exe", "StreamDeck", "WindowsTerminal", "", undefined]) assert.equal(isShell(other), false, String(other));
});
