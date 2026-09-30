// Teste de afinidade com estrutura conhecida: 12 comunidades em anel (cada uma ligada só às vizinhas).
// Um bom layout deixa vizinhas do anel encostadas -> links entre grupos curtos.
import { mulberry32 } from "../src/brain-shape";
import { buildGraphCore, type LinkMap } from "../src/graph-core";
import { BrainLayout } from "../src/layout";

const rng = mulberry32(5);
const C = 12;
const per = 35;
const paths: string[] = [];
for (let c = 0; c < C; c++) for (let i = 0; i < per; i++) paths.push(`c${c}/n${i}.md`);
const links: LinkMap = {};
const note = (c: number, i: number) => paths[c * per + i];
for (let c = 0; c < C; c++)
	for (let i = 0; i < per; i++) {
		const out: Record<string, number> = {};
		for (let k = 0; k < 3; k++) out[note(c, Math.floor(rng() * per))] = 1; // dentro da comunidade
		if (rng() < 0.3) out[note((c + 1) % C, Math.floor(rng() * per))] = 1; // só com a próxima do anel
		links[note(c, i)] = out;
	}

const g = buildGraphCore(paths, links, { groupBy: "folder", includeOrphans: true });
const l = new BrainLayout(g);
while (l.running) l.tick();
let n = 0, sum = 0;
for (let e = 0; e < g.edges.length; e += 2) {
	const a = g.edges[e], b = g.edges[e + 1];
	if (g.group[a] === g.group[b]) continue;
	n++;
	sum += Math.hypot(l.pos[a * 3] - l.pos[b * 3], l.pos[a * 3 + 1] - l.pos[b * 3 + 1], l.pos[a * 3 + 2] - l.pos[b * 3 + 2]);
}
console.log(`anel de ${C} comunidades: ${n} links entre grupos, comprimento médio ${(sum / n).toFixed(3)}`);
