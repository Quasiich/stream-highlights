/**
 * Baut dist/stream-highlights.exe: den gebündelten Code samt Web-Oberfläche
 * in einer einzigen Datei, die ohne installiertes Node.js läuft.
 *
 *   npm run build:exe
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const exe = process.platform === "win32" ? "dist/stream-highlights.exe" : "dist/stream-highlights";

await rm("dist", { recursive: true, force: true });
await mkdir("dist");

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/app.cjs",
  logLevel: "warning",
});

await writeFile(
  "dist/sea-config.json",
  JSON.stringify(
    {
      main: "dist/app.cjs",
      output: exe,
      disableExperimentalSEAWarning: true,
      assets: { "index.html": "ui/index.html" },
    },
    null,
    2,
  ),
);

const sea = spawnSync(process.execPath, ["--build-sea", "dist/sea-config.json"], { stdio: "inherit" });
if (sea.status !== 0) process.exit(sea.status ?? 1);

await rm("dist/app.cjs");
await rm("dist/sea-config.json");
console.log(`Fertig: ${exe}`);
