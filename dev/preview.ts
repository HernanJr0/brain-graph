// Harness de desenvolvimento: renderiza o BrainRenderer fora do Obsidian com um vault falso.
import { mulberry32 } from "../src/brain-shape";
import { buildGraphCore, type LinkMap } from "../src/graph-core";
import { BrainRenderer } from "../src/renderer";

const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? 1500);
const rng = mulberry32(99);
const paths: string[] = [];
const links: LinkMap = {};
const clusters = Number(params.get("clusters") ?? 14);
const orphanRate = Number(params.get("orphans") ?? 0.08);
for (let i = 0; i < N; i++) paths.push(`Pasta${i % clusters}/Nota ${i}.md`);
for (let i = 0; i < N; i++) {
	if (rng() < orphanRate) continue; // órfãs
	const out: Record<string, number> = {};
	const k = 1 + Math.floor(rng() * rng() * 6);
	for (let j = 0; j < k; j++) {
		const same = rng() < 0.85;
		let t = same ? (Math.floor(rng() * (N / clusters)) * clusters + (i % clusters)) : Math.floor(rng() * N);
		t = Math.min(N - 1, t);
		if (rng() < 0.15) t = (i % clusters) * 3; // hubs
		out[paths[t]] = 1;
	}
	links[paths[i]] = out;
}

const stage = document.getElementById("stage")!;
const mode = (params.get("mode") as "3d" | "2d") ?? "3d";
const r = new BrainRenderer(stage, { mode, showCortex: true, nodeSize: 1, hubLabels: true, glow: !params.has("noglow"), hoverPulses: true, ambientPulses: !params.has("noambient"), ambientCount: 45, idleAnimation: !params.has("noidle"), surface: !params.has("cloud"), dof: !params.has("nodof"), idleOrbit: true }, {
	onNodeClick: (i) => console.log("click", i),
});
const g = buildGraphCore(paths, links, { groupBy: "links", includeOrphans: true });
r.setGraph(g);
const preset = params.get("view");
if (preset) r.applyPreset(preset as "lateral");
(window as any).brain = r;
document.getElementById("stats")!.textContent = `${g.ids.length} notas · ${g.edges.length / 2} links · ${g.groupCount} regiões`;
window.addEventListener("resize", () => r.resize());
(window as any).layoutDone = new Promise<number>((resolve) => {
	const t0 = performance.now();
	const check = () => ((r as any).layout.running ? requestAnimationFrame(check) : resolve(performance.now() - t0));
	check();
});

import { WebGLRenderTarget } from "three";
(window as any).RT = WebGLRenderTarget;
