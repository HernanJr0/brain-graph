import { mulberry32 } from "../src/brain-shape";
import { buildGraphCore, type LinkMap } from "../src/graph-core";
import { BrainLayout } from "../src/layout";
for (const N of [1500, 8000, 20000]) {
	const rng = mulberry32(99);
	const paths: string[] = [];
	const links: LinkMap = {};
	const clusters = 30;
	for (let i = 0; i < N; i++) paths.push(`P${i % clusters}/N${i}.md`);
	for (let i = 0; i < N; i++) {
		const out: Record<string, number> = {};
		const k = 1 + Math.floor(rng() * rng() * 6);
		for (let j = 0; j < k; j++) {
			let t = rng() < 0.85 ? Math.floor(rng() * (N / clusters)) * clusters + (i % clusters) : Math.floor(rng() * N);
			out[paths[Math.min(N - 1, t)]] = 1;
		}
		links[paths[i]] = out;
	}
	let t = performance.now();
	const g = buildGraphCore(paths, links, { groupBy: "links", includeOrphans: true });
	const tg = performance.now() - t;
	t = performance.now();
	const l = new BrainLayout(g);
	const ti = performance.now() - t;
	t = performance.now();
	let it = 0;
	while (l.running) { l.tick(); it++; }
	const tl = performance.now() - t;
	console.log(`n=${N} edges=${g.edges.length / 2} groups=${g.groupCount} | graph ${tg.toFixed(0)}ms, init ${ti.toFixed(0)}ms, layout ${tl.toFixed(0)}ms (${it} it, ${(tl / it).toFixed(1)}ms/it)`);
}
