// Gera o build e copia para o vault de teste. Uso: npm run deploy [-- <caminho-do-vault>]
// O build roda aqui, e não num "npm run build && …" no package.json: no Windows o npm 11 escapa
// para o cmd (com ^) o argumento com espaço de um script encadeado, e o ^ chega literal no caminho.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const vault = process.argv[2] ?? process.env.BRAIN_GRAPH_VAULT ?? join(homedir(), "Documents", "BrainGraph-Teste");
execSync("npm run build", { stdio: "inherit" });
const dest = join(vault, ".obsidian", "plugins", "brain-graph");
mkdirSync(dest, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(dest, f));
console.log(`Plugin copiado para ${dest}`);
