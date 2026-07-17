// Kopiert node-hid (natives Modul) samt Abhaengigkeit in den Plugin-Ordner,
// damit Node es zur Laufzeit neben bin/plugin.js findet.
import { cpSync, mkdirSync, existsSync } from "node:fs";

const target = "com.holgermilz.myatxmousecontrol.sdPlugin/bin/node_modules";
mkdirSync(target, { recursive: true });

for (const mod of ["node-hid", "pkg-prebuilds"]) {
  const src = `node_modules/${mod}`;
  if (!existsSync(src)) {
    console.error(`FEHLER: ${src} nicht gefunden - erst 'npm install' ausfuehren.`);
    process.exit(1);
  }
  cpSync(src, `${target}/${mod}`, { recursive: true });
  console.log(`kopiert: ${mod}`);
}
