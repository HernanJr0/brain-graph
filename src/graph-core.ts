import { mulberry32 } from "./brain-shape";

export type GroupBy = "links" | "folder";

export interface GraphCore {
	/** Caminho de cada nó (id estável entre rebuilds). */
	ids: string[];
	names: string[];
	/** Pares [a, b] achatados, sem duplicatas, não direcionados. */
	edges: Uint32Array;
	degree: Uint32Array;
	neighbors: number[][];
	nodeEdges: number[][];
	/** Região de cada nó; -1 = órfão (vai para o cerebelo). */
	group: Int32Array;
	groupCount: number;
	/** Índice original em `paths` de cada nó mantido. */
	source: number[];
}

export type LinkMap = Record<string, Record<string, number>>;

export function buildGraphCore(
	paths: string[],
	links: LinkMap,
	opts: { groupBy: GroupBy; includeOrphans: boolean },
): GraphCore {
	const all = paths.length;
	const index = new Map<string, number>();
	paths.forEach((p, i) => index.set(p, i));

	const seen = new Set<number>();
	const rawEdges: number[] = [];
	const rawDegree = new Uint32Array(all);
	for (const src in links) {
		const i = index.get(src);
		if (i === undefined) continue;
		for (const dst in links[src]) {
			const j = index.get(dst);
			if (j === undefined || j === i) continue;
			const a = Math.min(i, j);
			const b = Math.max(i, j);
			const key = a * all + b;
			if (seen.has(key)) continue;
			seen.add(key);
			rawEdges.push(a, b);
			rawDegree[a]++;
			rawDegree[b]++;
		}
	}

	const remap = new Int32Array(all).fill(-1);
	const source: number[] = [];
	for (let i = 0; i < all; i++) {
		if (opts.includeOrphans || rawDegree[i] > 0) {
			remap[i] = source.length;
			source.push(i);
		}
	}
	const n = source.length;
	const edges = new Uint32Array(rawEdges.length);
	for (let k = 0; k < rawEdges.length; k++) edges[k] = remap[rawEdges[k]];

	const degree = new Uint32Array(n);
	const neighbors: number[][] = Array.from({ length: n }, () => []);
	const nodeEdges: number[][] = Array.from({ length: n }, () => []);
	for (let e = 0; e < edges.length / 2; e++) {
		const a = edges[e * 2];
		const b = edges[e * 2 + 1];
		degree[a]++;
		degree[b]++;
		neighbors[a].push(b);
		neighbors[b].push(a);
		nodeEdges[a].push(e);
		nodeEdges[b].push(e);
	}

	const ids = source.map((i) => paths[i]);
	const names = ids.map((p) => {
		const base = p.slice(p.lastIndexOf("/") + 1);
		return base.endsWith(".md") ? base.slice(0, -3) : base;
	});

	const raw =
		opts.groupBy === "folder"
			? folderLabels(ids)
			: labelPropagation(n, neighbors);

	// Compacta rótulos por tamanho (maior região = 0); órfãos ficam em -1.
	const sizes = new Map<number, number>();
	for (let i = 0; i < n; i++) {
		if (degree[i] === 0) continue;
		sizes.set(raw[i], (sizes.get(raw[i]) ?? 0) + 1);
	}
	const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	const compact = new Map<number, number>();
	order.forEach(([label], k) => compact.set(label, k));
	const group = new Int32Array(n);
	for (let i = 0; i < n; i++) group[i] = degree[i] === 0 ? -1 : compact.get(raw[i])!;

	return { ids, names, edges, degree, neighbors, nodeEdges, group, groupCount: order.length, source };
}

function folderLabels(ids: string[]): Int32Array {
	const byFolder = new Map<string, number>();
	const out = new Int32Array(ids.length);
	ids.forEach((p, i) => {
		const slash = p.indexOf("/");
		const top = slash === -1 ? "" : p.slice(0, slash);
		if (!byFolder.has(top)) byFolder.set(top, byFolder.size);
		out[i] = byFolder.get(top)!;
	});
	return out;
}

/** Detecção de comunidades por propagação de rótulos (barata e determinística). */
function labelPropagation(n: number, neighbors: number[][]): Int32Array {
	const label = new Int32Array(n);
	for (let i = 0; i < n; i++) label[i] = i;
	const order = Array.from({ length: n }, (_, i) => i);
	const rng = mulberry32(1337);
	const counts = new Map<number, number>();
	for (let it = 0; it < 30; it++) {
		for (let i = n - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[order[i], order[j]] = [order[j], order[i]];
		}
		let changed = 0;
		for (const i of order) {
			const nb = neighbors[i];
			if (nb.length === 0) continue;
			counts.clear();
			let best = label[i];
			let bestCount = 0;
			for (const j of nb) {
				const l = label[j];
				const c = (counts.get(l) ?? 0) + 1;
				counts.set(l, c);
				if (c > bestCount || (c === bestCount && l < best)) {
					bestCount = c;
					best = l;
				}
			}
			if (best !== label[i]) {
				label[i] = best;
				changed++;
			}
		}
		if (changed === 0) break;
	}
	return label;
}
