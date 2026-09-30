// Copia o build para o vault de teste. Uso: npm run deploy [-- <caminho-do-vault>]
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const vault = process.argv[2] ?? process.env.BRAIN_GRAPH_VAULT ?? join(homedir(), "Documents", "BrainGraph-Teste");
const dest = join(vault, ".obsidian", "plugins", "brain-graph");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(dest, f));
console.log(`Plugin copiado para ${dest}`);
