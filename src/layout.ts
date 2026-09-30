import {
	CEREBELLUM,
	cortexPoint,
	mulberry32,
	projectToCerebellum,
	projectToCortex,
} from "./brain-shape";
import type { GraphCore } from "./graph-core";

// Nós ficam numa película logo acima da superfície (a malha do cérebro é opaca).
const CORTEX_INNER = 1.012;
const CORTEX_OUTER = 1.045;
const CEREB_INNER = 1.03;
const CEREB_OUTER = 1.09;
const ALPHA_MIN = 0.01;
/** Área aproximada da camada cortical visível (u²). */
const CORTEX_AREA = 10;

/**
 * Layout em duas fases:
 * 1. "Vagas" uniformes são espalhadas pelo córtex e cada região do grafo ganha uma
 *    mancha contígua de vagas, proporcional ao seu tamanho (hubs no centro da mancha).
 * 2. Forças fazem o ajuste fino: molas nos links (fracas entre regiões), repulsão local
 *    via spatial hash e uma gravidade leve de cada nó para a sua vaga. A cada passo,
 *    tudo é projetado de volta para a camada cortical (órfãos: cerebelo).
 */
export class BrainLayout {
	readonly pos: Float32Array;
	alpha: number;
	private readonly n: number;
	private readonly home: Float32Array;
	private readonly repulse: number;
	private readonly head: Int32Array;
	private readonly next: Int32Array;
	private readonly mask: number;
	/** Vaults grandes esfriam mais rápido: a distribuição inicial por vagas já é boa. */
	private readonly decay: number;

	constructor(private readonly g: GraphCore, prev?: Map<string, ArrayLike<number>>) {
		const n = (this.n = g.ids.length);
		this.pos = new Float32Array(n * 3);
		this.home = new Float32Array(n * 3);
		const rng = mulberry32(42);

		const members: number[][] = Array.from({ length: g.groupCount }, () => []);
		const orphans: number[] = [];
		for (let i = 0; i < n; i++) (g.group[i] < 0 ? orphans : members[g.group[i]]).push(i);
		const cortexCount = n - orphans.length;

		this.repulse = Math.min(0.2, Math.max(0.025, Math.sqrt(CORTEX_AREA / Math.max(cortexCount, 1))));

		this.assignCortex(members, cortexCount, rng);
		for (const i of orphans) {
			const o = i * 3;
			this.home[o] = CEREBELLUM.x + (rng() * 2 - 1) * CEREBELLUM.rx;
			this.home[o + 1] = CEREBELLUM.y + (rng() * 2 - 1) * CEREBELLUM.ry;
			this.home[o + 2] = CEREBELLUM.z + (rng() * 2 - 1) * CEREBELLUM.rz;
			projectToCerebellum(this.home, o, CEREB_INNER, CEREB_OUTER);
		}

		let reused = 0;
		for (let i = 0; i < n; i++) {
			const o = i * 3;
			const old = prev?.get(g.ids[i]);
			if (old) {
				// Mantém o nó onde estava: rebuilds incrementais não "embaralham" o cérebro.
				this.home[o] = old[0];
				this.home[o + 1] = old[1];
				this.home[o + 2] = old[2];
				reused++;
			}
			this.pos[o] = this.home[o];
			this.pos[o + 1] = this.home[o + 1];
			this.pos[o + 2] = this.home[o + 2];
		}
		this.alpha = n > 0 && reused / n > 0.8 ? 0.2 : 1;
		this.decay = n > 5000 ? 0.965 : 0.985;

		let size = 16;
		while (size < n * 2) size <<= 1;
		this.head = new Int32Array(size);
		this.next = new Int32Array(Math.max(n, 1));
		this.mask = size - 1;
	}

	get running(): boolean {
		return this.alpha > ALPHA_MIN && this.n > 0;
	}

	/** Roda iterações até estourar o orçamento de tempo (ms). Retorna true se ainda não convergiu. */
	stepFor(budgetMs: number): boolean {
		const start = performance.now();
		while (this.running && performance.now() - start < budgetMs) this.tick();
		return this.running;
	}

	tick(): void {
		const { pos, home, g, n } = this;
		const a = this.alpha;
		const R = this.repulse;

		// Molas: fortes dentro da região, fracas entre regiões (senão o cérebro colapsa).
		const edges = g.edges;
		for (let e = 0; e < edges.length; e += 2) {
			const ia = edges[e];
			const ib = edges[e + 1];
			const i = ia * 3;
			const j = ib * 3;
			const dx = pos[j] - pos[i];
			const dy = pos[j + 1] - pos[i + 1];
			const dz = pos[j + 2] - pos[i + 2];
			const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (d < 1e-6) continue;
			const k = (g.group[ia] === g.group[ib] ? 0.25 : 0.03) * a;
			const f = (Math.min(d - R, R * 3) / d) * k * 0.5;
			pos[i] += dx * f;
			pos[i + 1] += dy * f;
			pos[i + 2] += dz * f;
			pos[j] -= dx * f;
			pos[j + 1] -= dy * f;
			pos[j + 2] -= dz * f;
		}

		// Gravidade leve para a vaga de origem: mantém a distribuição uniforme.
		const gk = 0.04 * a + 0.005;
		for (let o = 0; o < n * 3; o++) pos[o] += (home[o] - pos[o]) * gk;

		// Repulsão local com spatial hash (O(n) em média).
		const inv = 1 / R;
		const { head, next, mask } = this;
		head.fill(-1);
		for (let i = 0; i < n; i++) {
			const o = i * 3;
			const h = hash(cell(pos[o], inv), cell(pos[o + 1], inv), cell(pos[o + 2], inv)) & mask;
			next[i] = head[h];
			head[h] = i;
		}
		const rk = 0.35;
		for (let i = 0; i < n; i++) {
			const o = i * 3;
			const cx = cell(pos[o], inv);
			const cy = cell(pos[o + 1], inv);
			const cz = cell(pos[o + 2], inv);
			for (let ox = -1; ox <= 1; ox++)
				for (let oy = -1; oy <= 1; oy++)
					for (let oz = -1; oz <= 1; oz++) {
						let j = head[hash(cx + ox, cy + oy, cz + oz) & mask];
						while (j !== -1) {
							if (j > i) {
								const p = j * 3;
								const dx = pos[p] - pos[o];
								const dy = pos[p + 1] - pos[o + 1];
								const dz = pos[p + 2] - pos[o + 2];
								const d2 = dx * dx + dy * dy + dz * dz;
								if (d2 < R * R) {
									const d = Math.sqrt(d2) || 1e-4;
									const f = ((R - d) / d) * rk * 0.5;
									pos[o] -= dx * f;
									pos[o + 1] -= dy * f;
									pos[o + 2] -= dz * f;
									pos[p] += dx * f;
									pos[p + 1] += dy * f;
									pos[p + 2] += dz * f;
								}
							}
							j = next[j];
						}
					}
		}

		for (let i = 0; i < n; i++) this.project(i);
		this.alpha *= this.decay;
	}

	/** Distribui vagas pelo córtex e dá a cada região uma mancha contígua delas. */
	private assignCortex(members: number[][], count: number, rng: () => number): void {
		if (count === 0) return;
		const slots = cortexSlots(count, rng);
		const free: number[] = Array.from({ length: slots.length / 3 }, (_, s) => s);
		const seed = [0, 0, 0];
		const K = members.length;
		const golden = Math.PI * (3 - Math.sqrt(5));

		for (let k = 0; k < K; k++) {
			const list = members[k];
			if (list.length === 0 || free.length === 0) continue;
			// Sementes em espiral de Fibonacci, empurradas para a face lateral.
			const y = K === 1 ? 0.2 : 0.85 - ((k + 0.5) / K) * 1.5;
			const r = Math.sqrt(Math.max(0, 1 - y * y));
			const h = k % 2 === 0 ? 1 : -1;
			let dx = h * Math.max(Math.abs(Math.cos(golden * k) * r), 0.4);
			let dy = y;
			let dz = Math.sin(golden * k) * r;
			const l = Math.hypot(dx, dy, dz);
			dx /= l;
			dy /= l;
			dz /= l;
			cortexPoint(h, dx, dy, dz, 0.9, seed);

			const dist = (s: number) =>
				(slots[s * 3] - seed[0]) ** 2 + (slots[s * 3 + 1] - seed[1]) ** 2 + (slots[s * 3 + 2] - seed[2]) ** 2;
			const take = Math.min(list.length, free.length);
			let chosen: number[];
			if (take > 8) {
				const scored = free.map((s) => [dist(s), s] as const).sort((p, q) => p[0] - q[0]);
				chosen = scored.slice(0, take).map((p) => p[1]);
				const used = new Set(chosen);
				let w = 0;
				for (const s of free) if (!used.has(s)) free[w++] = s;
				free.length = w;
			} else {
				chosen = [];
				for (let t = 0; t < take; t++) {
					let best = 0;
					let bestD = Infinity;
					for (let f = 0; f < free.length; f++) {
						const d = dist(free[f]);
						if (d < bestD) {
							bestD = d;
							best = f;
						}
					}
					chosen.push(free[best]);
					free[best] = free[free.length - 1];
					free.pop();
				}
			}

			// Hubs no centro da mancha.
			const byDegree = [...list].sort((p, q) => this.g.degree[q] - this.g.degree[p]);
			for (let t = 0; t < byDegree.length; t++) {
				const i = byDegree[t];
				const s = chosen[Math.min(t, chosen.length - 1)];
				this.home[i * 3] = slots[s * 3] + (t >= chosen.length ? (rng() - 0.5) * 0.02 : 0);
				this.home[i * 3 + 1] = slots[s * 3 + 1];
				this.home[i * 3 + 2] = slots[s * 3 + 2];
			}
		}
	}

	private project(i: number): void {
		const o = i * 3;
		if (this.g.group[i] < 0) {
			projectToCerebellum(this.pos, o, CEREB_INNER, CEREB_OUTER);
		} else {
			// Evita que nós fiquem exatamente na fissura.
			if (Math.abs(this.pos[o]) < 0.02) this.pos[o] = this.pos[o] < 0 ? -0.02 : 0.02;
			projectToCortex(this.pos, o, CORTEX_INNER, CORTEX_OUTER);
		}
	}
}

/** Pontos quase uniformes na camada cortical (espiral de Fibonacci por hemisfério). */
function cortexSlots(count: number, rng: () => number): Float32Array {
	const out: number[] = [];
	const p = [0, 0, 0];
	const golden = Math.PI * (3 - Math.sqrt(5));
	let m = Math.ceil(count * 0.75);
	while (out.length / 3 < count) {
		out.length = 0;
		for (const h of [1, -1]) {
			for (let k = 0; k < m; k++) {
				const y = 1 - ((k + 0.5) / m) * 2;
				const r = Math.sqrt(1 - y * y);
				const dx = Math.cos(golden * k) * r;
				const dz = Math.sin(golden * k) * r;
				// Face medial e base quase não recebem nós (ficam escondidas).
				if (dx * h < -0.3 || y < -0.75) continue;
				cortexPoint(h, dx, y, dz, 1.015 + rng() * 0.025, p);
				out.push(p[0], p[1], p[2]);
			}
		}
		m = Math.ceil(m * 1.25);
	}
	return new Float32Array(out);
}

function cell(v: number, inv: number): number {
	return Math.floor((v + 4) * inv);
}

function hash(x: number, y: number, z: number): number {
	return Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
}
