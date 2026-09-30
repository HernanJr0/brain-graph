// Mede a qualidade do layout num vault real: comprimento dos links entre grupos e estabilidade.
// Uso: npx esbuild dev/quality.ts --bundle --platform=node --outfile=dev/quality.js && node dev/quality.js [vault]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { buildGraphCore, type LinkMap } from "../src/graph-core";
import { BrainLayout } from "../src/layout";

const vault = process.argv[2] ?? join(homedir(), "Documents", "BrainGraph-Teste");
const files: string[] = [];
const walk = (dir: string) => {
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) walk(full);
		else if (name.endsWith(".md")) files.push(relative(vault, full).split("\\").join("/"));
	}
};
walk(vault);
const byName = new Map(files.map((p) => [p.slice(p.lastIndexOf("/") + 1, -3), p]));
const links: LinkMap = {};
for (const p of files) {
	const out: Record<string, number> = {};
	for (const m of readFileSync(join(vault, p), "utf8").matchAll(/\[\[([^\]|#]+)/g)) {
		const t = byName.get(m[1].trim());
		if (t) out[t] = 1;
	}
	links[p] = out;
}

const g = buildGraphCore(files, links, { groupBy: "links", includeOrphans: true });
const settle = (l: BrainLayout) => {
	while (l.running) l.tick();
	return l;
};
const dist = (pos: Float32Array, a: number, b: number) =>
	Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);

let t = performance.now();
const full = settle(new BrainLayout(g));
const fullMs = performance.now() - t;
let cross = 0, crossLen = 0, intra = 0, intraLen = 0;
for (let e = 0; e < g.edges.length; e += 2) {
	const a = g.edges[e], b = g.edges[e + 1];
	const d = dist(full.pos, a, b);
	if (g.group[a] === g.group[b]) { intra++; intraLen += d; } else { cross++; crossLen += d; }
}
console.log(`${g.ids.length} notas, ${g.edges.length / 2} links, ${g.groupCount} grupos | layout completo ${fullMs.toFixed(0)} ms`);
console.log(`links entre grupos: ${cross}, comprimento médio ${(crossLen / cross).toFixed(3)}`);
console.log(`links dentro do grupo: ${intra}, comprimento médio ${(intraLen / intra).toFixed(3)}`);

// Persistência: reabrir com tudo salvo não deve calcular nada nem mover nada.
const saved = new Map(g.ids.map((id, i) => [id, [full.pos[i * 3], full.pos[i * 3 + 1], full.pos[i * 3 + 2], g.group[i] < 0 ? 1 : 0]]));
t = performance.now();
const reopened = new BrainLayout(g, saved);
const reopenMs = performance.now() - t;
let maxMove = 0;
for (let i = 0; i < g.ids.length; i++) maxMove = Math.max(maxMove, dist(reopened.pos, i, i) + Math.hypot(reopened.pos[i * 3] - full.pos[i * 3], reopened.pos[i * 3 + 1] - full.pos[i * 3 + 1], reopened.pos[i * 3 + 2] - full.pos[i * 3 + 2]));
console.log(`reabrir do cache: ${reopenMs.toFixed(0)} ms, notas novas ${reopened.newCount}, rodando=${reopened.running}, maior deslocamento ${maxMove.toFixed(5)}`);

// Nota nova: as antigas ficam paradas e a nova nasce perto dos vizinhos.
const extra = "Nova nota de teste.md";
const targets = g.ids.filter((_, i) => g.group[i] === 0).slice(0, 3);
const g2 = buildGraphCore([...files, extra], { ...links, [extra]: Object.fromEntries(targets.map((x) => [x, 1])) }, { groupBy: "links", includeOrphans: true });
const inc = settle(new BrainLayout(g2, saved));
let moved = 0;
for (let i = 0; i < g2.ids.length; i++) {
	const old = saved.get(g2.ids[i]);
	if (!old) continue;
	if (Math.hypot(inc.pos[i * 3] - old[0], inc.pos[i * 3 + 1] - old[1], inc.pos[i * 3 + 2] - old[2]) > 1e-6) moved++;
}
const ni = g2.ids.indexOf(extra);
const nearest = Math.min(...targets.map((x) => dist(inc.pos, ni, g2.ids.indexOf(x))));
console.log(`nota nova: notas antigas que se moveram ${moved}, distância até o vizinho mais próximo ${nearest.toFixed(3)} (média geral entre links ${((crossLen + intraLen) / (cross + intra)).toFixed(3)})`);
