import {
	CEREBELLUM,
	cortexPoint,
	mulberry32,
	projectToCerebellum,
	projectToCortex,
} from "./brain-shape";
import type { GraphCore } from "./graph-core";

/** Mude quando a anatomia ou o algoritmo mudarem: invalida posições salvas. */
export const LAYOUT_VERSION = 3;

// Notas ficam numa película logo acima da superfície do cérebro (que é quase opaca).
const CORTEX_INNER = 1.012;
const CORTEX_OUTER = 1.045;
const CEREB_INNER = 1.03;
const CEREB_OUTER = 1.09;
const ALPHA_MIN = 0.01;
/** Área aproximada da camada cortical visível (u²). */
const CORTEX_AREA = 10;
/** Acima disso, só os maiores grupos entram na simulação de sementes; os menores seguem os vizinhos. */
const MAX_SIM_GROUPS = 400;
/** Se menos que isso das notas tem posição salva, o layout é refeito do zero. */
const MIN_REUSE = 0.5;

/**
 * Posição salva de uma nota: [x, y, z, órfã (1) ou córtex (0)].
 * O 4º valor evita reaproveitar a posição quando a nota mudou de estrutura.
 */
export type SavedPosition = ArrayLike<number>;

/**
 * Layout em três fases:
 * 1. Sementes por afinidade: os grupos são organizados numa esfera (grupos muito ligados
 *    ficam vizinhos) e isso é projetado no córtex.
 * 2. "Vagas" uniformes são divididas: todos os grupos crescem juntos a partir das sementes,
 *    cada um até a sua cota (hubs no centro da mancha).
 * 3. Forças fazem o ajuste fino. Com posições salvas, as notas conhecidas ficam fixas e só
 *    as novas se acomodam, nascendo perto das notas que elas citam.
 */
export class BrainLayout {
	readonly pos: Float32Array;
	alpha: number;
	/** Notas que não tinham posição salva (0 = tudo veio do cache, nada a calcular). */
	readonly newCount: number;
	private readonly n: number;
	private readonly home: Float32Array;
	private readonly fixed: Uint8Array;
	private readonly repulse: number;
	private readonly head: Int32Array;
	private readonly next: Int32Array;
	private readonly mask: number;
	/** Vaults grandes esfriam mais rápido: a distribuição inicial por vagas já é boa. */
	private readonly decay: number;

	constructor(private readonly g: GraphCore, prev?: Map<string, SavedPosition>) {
		const n = (this.n = g.ids.length);
		this.pos = new Float32Array(n * 3);
		this.home = new Float32Array(n * 3);
		this.fixed = new Uint8Array(n);
		const rng = mulberry32(42);

		const members: number[][] = Array.from({ length: g.groupCount }, () => []);
		const orphans: number[] = [];
		for (let i = 0; i < n; i++) (g.group[i] < 0 ? orphans : members[g.group[i]]).push(i);
		const cortexCount = n - orphans.length;

		this.repulse = Math.min(0.2, Math.max(0.025, Math.sqrt(CORTEX_AREA / Math.max(cortexCount, 1))));

		// Posições salvas utilizáveis (mesma estrutura: órfã continua órfã, córtex continua córtex).
		const saved: (SavedPosition | undefined)[] = g.ids.map((id, i) => {
			const p = prev?.get(id);
			if (!p) return undefined;
			const wasOrphan = p.length > 3 ? p[3] === 1 : g.group[i] < 0;
			return wasOrphan === g.group[i] < 0 ? p : undefined;
		});
		const reuse = n > 0 ? saved.filter(Boolean).length / n : 0;
		const incremental = reuse >= MIN_REUSE;

		// Fases 1 e 2 (também servem de fallback para notas novas sem vizinhos conhecidos).
		// Se tudo veio salvo, não há o que calcular: o cérebro abre instantaneamente.
		const allSaved = incremental && saved.every(Boolean);
		if (!allSaved) this.assignCortex(members, cortexCount, rng);
		for (const i of orphans) {
			const o = i * 3;
			this.home[o] = CEREBELLUM.x + (rng() * 2 - 1) * CEREBELLUM.rx;
			this.home[o + 1] = CEREBELLUM.y + (rng() * 2 - 1) * CEREBELLUM.ry;
			this.home[o + 2] = CEREBELLUM.z + (rng() * 2 - 1) * CEREBELLUM.rz;
			projectToCerebellum(this.home, o, CEREB_INNER, CEREB_OUTER);
		}

		let fresh = n;
		if (incremental) {
			fresh = 0;
			for (let i = 0; i < n; i++) {
				const p = saved[i];
				if (!p) continue;
				this.home.set([p[0], p[1], p[2]], i * 3);
				this.fixed[i] = 1;
			}
			// Notas novas nascem no centro das notas conhecidas que elas citam.
			for (let i = 0; i < n; i++) {
				if (this.fixed[i]) continue;
				fresh++;
				let sx = 0, sy = 0, sz = 0, c = 0;
				for (const j of g.neighbors[i]) {
					if (!this.fixed[j]) continue;
					sx += this.home[j * 3];
					sy += this.home[j * 3 + 1];
					sz += this.home[j * 3 + 2];
					c++;
				}
				if (c > 0 && g.group[i] >= 0) {
					const o = i * 3;
					this.home[o] = sx / c + (rng() - 0.5) * this.repulse;
					this.home[o + 1] = sy / c + (rng() - 0.5) * this.repulse;
					this.home[o + 2] = sz / c + (rng() - 0.5) * this.repulse;
					this.pos.set(this.home.subarray(o, o + 3), o);
					this.project(i);
					this.home.set(this.pos.subarray(o, o + 3), o);
				}
			}
		}
		this.newCount = fresh;
		this.pos.set(this.home);
		this.alpha = fresh === 0 ? 0 : incremental ? 0.3 : 1;
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
		const { pos, home, g, n, fixed } = this;
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

		for (let i = 0; i < n; i++) {
			if (fixed[i]) {
				// Notas conhecidas não se movem: o cérebro mantém a "memória espacial".
				pos[i * 3] = home[i * 3];
				pos[i * 3 + 1] = home[i * 3 + 1];
				pos[i * 3 + 2] = home[i * 3 + 2];
			} else this.project(i);
		}
		this.alpha *= this.decay;
	}

	/**
	 * Fase 1: uma semente no córtex por grupo. Os grupos são primeiro organizados numa esfera
	 * livre (grupos ligados se atraem, todos se repelem, sem limite de área, então ninguém fica
	 * preso). Faz algumas tentativas e projeta a de menor tensão no córtex, preservando vizinhanças.
	 */
	private groupSeeds(members: number[][], rng: () => number): Float32Array {
		const g = this.g;
		const K = members.length;
		const seeds = new Float32Array(K * 3);
		if (K === 0) return seeds;

		// Grafo dos grupos: peso = nº de links entre eles (normalizado pelo maior).
		const weights = new Map<number, number>();
		for (let e = 0; e < g.edges.length; e += 2) {
			const a = g.group[g.edges[e]];
			const b = g.group[g.edges[e + 1]];
			if (a < 0 || b < 0 || a === b) continue;
			const key = Math.min(a, b) * K + Math.max(a, b);
			weights.set(key, (weights.get(key) ?? 0) + 1);
		}
		let maxW = 1;
		for (const w of weights.values()) maxW = Math.max(maxW, w);
		const links: [number, number, number][] = [...weights].map(([key, w]) => [Math.floor(key / K), key % K, w / maxW]);
		const mean = members.reduce((acc, m) => acc + m.length, 0) / K;
		const mass = members.map((m) => Math.max(0.2, m.length / mean));

		// Os S maiores grupos entram na simulação; os menores seguem os vizinhos depois.
		const S = Math.min(K, MAX_SIM_GROUPS);
		const simLinks = links.filter(([a, b]) => a < S && b < S);
		const restarts = S <= 60 ? 4 : S <= 200 ? 2 : 1;
		let best: Float64Array = new Float64Array(0);
		let bestEnergy = Infinity;
		for (let r = 0; r < restarts; r++) {
			const u = sphereLayout(S, simLinks, mass, rng);
			let energy = 0;
			for (const [a, b, w] of simLinks)
				energy += w * Math.hypot(u[a * 3] - u[b * 3], u[a * 3 + 1] - u[b * 3 + 1], u[a * 3 + 2] - u[b * 3 + 2]);
			if (energy < bestEnergy) {
				bestEnergy = energy;
				best = u;
			}
		}

		const u = new Float64Array(K * 3);
		u.set(best);
		if (K > S) {
			const acc = new Float64Array(K * 3);
			for (const [a, b, w] of links) {
				for (const [small, big] of [[a, b], [b, a]]) {
					if (small < S || big >= S) continue;
					acc[small * 3] += u[big * 3] * w;
					acc[small * 3 + 1] += u[big * 3 + 1] * w;
					acc[small * 3 + 2] += u[big * 3 + 2] * w;
				}
			}
			const d = [0, 0, 0];
			for (let k = S; k < K; k++) {
				let x = acc[k * 3], y = acc[k * 3 + 1], z = acc[k * 3 + 2];
				if (x === 0 && y === 0 && z === 0) {
					randomUnit(rng, d);
					[x, y, z] = d;
				}
				const l = Math.hypot(x, y, z) || 1;
				u[k * 3] = x / l + (rng() - 0.5) * 0.05;
				u[k * 3 + 1] = y / l + (rng() - 0.5) * 0.05;
				u[k * 3 + 2] = z / l + (rng() - 0.5) * 0.05;
			}
		}

		const out = [0, 0, 0];
		for (let k = 0; k < K; k++) {
			sphereToCortex(u[k * 3], u[k * 3 + 1], u[k * 3 + 2], out);
			seeds.set(out, k * 3);
		}
		return seeds;
	}

	/**
	 * Fase 2: todos os grupos crescem ao mesmo tempo a partir das sementes, cada um até a sua
	 * cota de vagas (diagrama de potência: Voronoi com pesos ajustados iterativamente).
	 * Assim nenhum grupo "rouba" a área dos outros e as vizinhanças da fase 1 se mantêm.
	 */
	private assignCortex(members: number[][], count: number, rng: () => number): void {
		if (count === 0) return;
		const slots = cortexSlots(count, rng);
		const M = slots.length / 3;
		const K = members.length;
		const seeds = this.groupSeeds(members, rng);
		const target = members.map((m) => m.length);
		const weight = new Float64Array(K);
		const owner = new Int32Array(M);
		const counts = new Int32Array(K);
		// Área (≈ raio²) de uma nota: cada nota que falta a um grupo aumenta o peso dele nisso.
		const nodeArea = CORTEX_AREA / (Math.PI * count);
		const CAND = Math.min(K, 12);
		const cand = new Int32Array(M * CAND);
		const d2 = (s: number, k: number) =>
			(slots[s * 3] - seeds[k * 3]) ** 2 + (slots[s * 3 + 1] - seeds[k * 3 + 1]) ** 2 + (slots[s * 3 + 2] - seeds[k * 3 + 2]) ** 2;
		const refreshCandidates = () => {
			const order = Array.from({ length: K }, (_, k) => k);
			for (let s = 0; s < M; s++) {
				order.sort((p, q) => d2(s, p) - weight[p] - (d2(s, q) - weight[q]));
				for (let c = 0; c < CAND; c++) cand[s * CAND + c] = order[c];
			}
		};

		const iterations = 24;
		for (let it = 0; it < iterations; it++) {
			if (it % 6 === 0) refreshCandidates();
			counts.fill(0);
			for (let s = 0; s < M; s++) {
				let best = cand[s * CAND];
				let bestScore = Infinity;
				for (let c = 0; c < CAND; c++) {
					const k = cand[s * CAND + c];
					const score = d2(s, k) - weight[k];
					if (score < bestScore) {
						bestScore = score;
						best = k;
					}
				}
				owner[s] = best;
				counts[best]++;
			}
			if (it === iterations - 1) break;
			for (let k = 0; k < K; k++) weight[k] += 0.4 * (target[k] - counts[k]) * nodeArea;
			// Lloyd suave: a semente anda metade do caminho até o centro da própria mancha (regiões compactas).
			if (it >= 3) {
				const cx = new Float64Array(K * 3);
				for (let s = 0; s < M; s++) {
					const k = owner[s];
					cx[k * 3] += slots[s * 3];
					cx[k * 3 + 1] += slots[s * 3 + 1];
					cx[k * 3 + 2] += slots[s * 3 + 2];
				}
				for (let k = 0; k < K; k++) {
					if (!counts[k]) continue;
					for (let c = 0; c < 3; c++) seeds[k * 3 + c] += (cx[k * 3 + c] / counts[k] - seeds[k * 3 + c]) * 0.5;
					projectToCortex(seeds, k * 3, 0.92, 0.92);
				}
			}
		}

		const owned: number[][] = Array.from({ length: K }, () => []);
		for (let s = 0; s < M; s++) owned[owner[s]].push(s);
		for (let k = 0; k < K; k++) {
			const list = members[k];
			if (list.length === 0) continue;
			const mine = owned[k].sort((p, q) => d2(p, k) - d2(q, k));
			// Hubs no centro da mancha; se faltar vaga, as notas extras ficam perto da semente.
			const byDegree = [...list].sort((p, q) => this.g.degree[q] - this.g.degree[p]);
			for (let t = 0; t < byDegree.length; t++) {
				const o = byDegree[t] * 3;
				if (t < mine.length) {
					const s = mine[t];
					this.home[o] = slots[s * 3];
					this.home[o + 1] = slots[s * 3 + 1];
					this.home[o + 2] = slots[s * 3 + 2];
				} else {
					this.home[o] = seeds[k * 3] + (rng() - 0.5) * this.repulse * 2;
					this.home[o + 1] = seeds[k * 3 + 1] + (rng() - 0.5) * this.repulse * 2;
					this.home[o + 2] = seeds[k * 3 + 2] + (rng() - 0.5) * this.repulse * 2;
				}
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

/** Layout de forças de S grupos sobre a esfera unitária (partida aleatória, para as tentativas variarem). */
function sphereLayout(S: number, links: [number, number, number][], mass: number[], rng: () => number): Float64Array {
	const u = new Float64Array(S * 3);
	const d = [0, 0, 0];
	for (let k = 0; k < S; k++) {
		randomUnit(rng, d);
		u.set(d, k * 3);
	}
	if (S < 2) return u;
	const f = new Float64Array(S * 3);
	const kr = 1 / S;
	const iterations = 300;
	for (let it = 0; it < iterations; it++) {
		const step = 0.15 * (1 - it / iterations) + 0.01;
		f.fill(0);
		for (let a = 0; a < S; a++)
			for (let b = a + 1; b < S; b++) {
				const dx = u[a * 3] - u[b * 3];
				const dy = u[a * 3 + 1] - u[b * 3 + 1];
				const dz = u[a * 3 + 2] - u[b * 3 + 2];
				const dd = dx * dx + dy * dy + dz * dz + 1e-3;
				const rep = (kr * mass[a] * mass[b]) / (dd * Math.sqrt(dd));
				f[a * 3] += dx * rep;
				f[a * 3 + 1] += dy * rep;
				f[a * 3 + 2] += dz * rep;
				f[b * 3] -= dx * rep;
				f[b * 3 + 1] -= dy * rep;
				f[b * 3 + 2] -= dz * rep;
			}
		for (const [a, b, w] of links) {
			for (let c = 0; c < 3; c++) {
				const dv = (u[b * 3 + c] - u[a * 3 + c]) * w;
				f[a * 3 + c] += dv;
				f[b * 3 + c] -= dv;
			}
		}
		for (let k = 0; k < S; k++) {
			const o = k * 3;
			const fl = Math.hypot(f[o], f[o + 1], f[o + 2]);
			const scale = (step / Math.sqrt(mass[k])) * (fl > 1 ? 1 / fl : 1);
			const x = u[o] + f[o] * scale;
			const y = u[o + 1] + f[o + 1] * scale;
			const z = u[o + 2] + f[o + 2] * scale;
			const l = Math.hypot(x, y, z) || 1;
			u[o] = x / l;
			u[o + 1] = y / l;
			u[o + 2] = z / l;
		}
	}
	return u;
}

/** Leva uma direção da esfera para o córtex, evitando a face medial e a base (onde não há vagas). */
function sphereToCortex(ux: number, uy: number, uz: number, out: number[]): void {
	const h = ux >= 0 ? 1 : -1;
	const x = h * (0.35 + 0.65 * Math.abs(ux));
	const y = uy >= 0 ? uy : uy * 0.55;
	const l = Math.hypot(x, y, uz) || 1;
	cortexPoint(h, x / l, y / l, uz / l, 0.92, out);
}

function randomUnit(rng: () => number, out: number[]): void {
	const u = rng() * 2 - 1;
	const phi = rng() * Math.PI * 2;
	const s = Math.sqrt(1 - u * u);
	out[0] = s * Math.cos(phi);
	out[1] = u;
	out[2] = s * Math.sin(phi);
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
