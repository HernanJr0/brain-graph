import { Color } from "three";
import type { GraphCore, GroupBy } from "./graph-core";

export type PaletteId = "nebula" | "aurora" | "ember" | "pastel" | "accent" | "okabe-ito";

export const PALETTE_NAMES: Record<PaletteId, string> = {
	nebula: "Nebula",
	aurora: "Aurora",
	ember: "Ember",
	pastel: "Pastel",
	accent: "Accent (theme color)",
	"okabe-ito": "Colorblind safe",
};

export interface PaletteDef {
	dark: string[];
	light: string[];
	/** Hex exibido como está também no escuro (sem a conversão para linear do visual original). */
	display?: boolean;
	/** Regiões além da paleta repetem as cores em vez de ganhar matizes novos pelo ângulo de ouro. */
	cycle?: boolean;
}

/** Paletas prontas, na ordem do tamanho da região (maior = 0). A "accent" é gerada a partir do tema. */
export const PALETTES: Record<Exclude<PaletteId, "accent">, PaletteDef> = {
	nebula: {
		dark: [
			"#5eead4", "#a78bfa", "#f472b6", "#60a5fa", "#fbbf24", "#34d399",
			"#fb7185", "#38bdf8", "#c084fc", "#f59e0b", "#4ade80", "#e879f9",
		],
		light: [
			"#2dd4bf", "#a78bfa", "#f472b6", "#60a5fa", "#f59e0b", "#34d399",
			"#fb7185", "#38bdf8", "#c084fc", "#fb923c", "#4ade80", "#e879f9",
		],
	},
	// Frios alternando verde, azul e violeta: as maiores regiões (vizinhas na lista) não saem parecidas.
	aurora: {
		dark: [
			"#5eead4", "#818cf8", "#4ade80", "#38bdf8", "#c4b5fd", "#34d399",
			"#60a5fa", "#a78bfa", "#22d3ee", "#86efac", "#93c5fd", "#2dd4bf",
		],
		light: [
			"#14b8a6", "#6366f1", "#22c55e", "#0ea5e9", "#8b5cf6", "#10b981",
			"#3b82f6", "#7c3aed", "#06b6d4", "#16a34a", "#2563eb", "#0d9488",
		],
	},
	ember: {
		dark: [
			"#fbbf24", "#fb7185", "#f472b6", "#fb923c", "#f87171", "#e879f9",
			"#facc15", "#fda4af", "#f97316", "#ec4899", "#fcd34d", "#d946ef",
		],
		light: [
			"#f59e0b", "#f43f5e", "#ec4899", "#f97316", "#ef4444", "#d946ef",
			"#eab308", "#e11d48", "#ea580c", "#db2777", "#ca8a04", "#c026d3",
		],
	},
	pastel: {
		dark: [
			"#99f6e4", "#c4b5fd", "#fbcfe8", "#bfdbfe", "#fde68a", "#bbf7d0",
			"#fecdd3", "#bae6fd", "#e9d5ff", "#fed7aa", "#d9f99d", "#f5d0fe",
		],
		light: [
			"#5eead4", "#c4b5fd", "#f9a8d4", "#93c5fd", "#fcd34d", "#86efac",
			"#fda4af", "#7dd3fc", "#d8b4fe", "#fdba74", "#bef264", "#f0abfc",
		],
	},
	// Okabe-Ito: 8 cores distinguíveis com os tipos comuns de daltonismo. Exibidas como estão
	// (converter para linear mudaria os tons e quebraria a distinção).
	"okabe-ito": {
		dark: ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7", "#999999"],
		light: ["#e69f00", "#56b4e9", "#009e73", "#c9b800", "#0072b2", "#d55e00", "#cc79a7", "#7a7a7a"],
		display: true,
		cycle: true,
	},
};

/** Tons da cor de destaque do Obsidian: matiz próximo, luminosidade variando. */
export function accentPalette(accent: Color, kind: "dark" | "light"): PaletteDef {
	const hsl = { h: 0, s: 0, l: 0 };
	accent.getHSL(hsl);
	const s = Math.max(0.5, hsl.s);
	const hues = [0, -14, 14, -28, 28, -7, 7, -21, 21, -35, 35, 0];
	const dark = [0.66, 0.74, 0.58, 0.7, 0.62, 0.78, 0.54, 0.68, 0.6, 0.72, 0.64, 0.82];
	const light = [0.5, 0.42, 0.58, 0.46, 0.54, 0.38, 0.6, 0.48, 0.44, 0.56, 0.4, 0.52];
	const tones = hues.map((dh, k) =>
		"#" + new Color().setHSL((hsl.h + dh / 360 + 1) % 1, s, (kind === "dark" ? dark : light)[k]).getHexString(),
	);
	return { dark: tones, light: tones, display: true, cycle: true };
}

// ---------- Cores escolhidas pelo usuário ----------

/** "#abc", "abc", "#aabbcc" ou "aabbcc" -> "#aabbcc"; qualquer outra coisa -> null. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
	if (!m) return null;
	const h = m[1].toLowerCase();
	return "#" + (h.length === 3 ? h.replace(/./g, (c) => c + c) : h);
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Limita a luminosidade perceptual (OKLab L) de uma cor sRGB, mantendo matiz e croma.
 * `rgb` são valores de tela (sRGB, 0–1) e são alterados no lugar.
 */
export function clampLightness(rgb: [number, number, number], min: number, max: number): void {
	const [r, g, b] = rgb.map(toLinear);
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	if (L >= min && L <= max) return;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const L2 = Math.min(max, Math.max(min, L));
	const l2 = (L2 + 0.3963377774 * A + 0.2158037573 * B) ** 3;
	const m2 = (L2 - 0.1055613458 * A - 0.0638541728 * B) ** 3;
	const s2 = (L2 - 0.0894841775 * A - 1.291485548 * B) ** 3;
	const out = [
		4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2,
		-1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2,
		-0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2,
	];
	for (let k = 0; k < 3; k++) rgb[k] = Math.min(1, Math.max(0, toGamma(Math.max(0, out[k]))));
}

// ---------- Regiões ----------

export interface Region {
	/** Índice da região no grafo; -1 = órfãs. */
	group: number;
	/** Pasta (agrupado por pasta) ou nota mais conectada (por links). */
	name: string;
	/** Membros, do mais conectado ao menos conectado. */
	members: number[];
	/** Notas que identificam a região entre rebuilds (agrupado por links). */
	anchors: string[];
	/** Pasta de topo (agrupado por pasta; "" = raiz do vault). */
	folder?: string;
}

const ANCHORS = 5;

/** Pasta de topo de um caminho ("" = raiz), a mesma usada no agrupamento por pasta. */
export function topFolder(path: string): string {
	const slash = path.indexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/** Regiões na ordem do tamanho, com as órfãs no fim. */
export function regionsOf(graph: GraphCore, groupBy: GroupBy): Region[] {
	const members: number[][] = Array.from({ length: graph.groupCount }, () => []);
	const orphans: number[] = [];
	graph.group.forEach((g, i) => (g < 0 ? orphans : members[g]).push(i));
	// Mais conectado primeiro; empate pelo caminho, para as âncoras não dependerem da ordem dos arquivos.
	const byDegree = (a: number, b: number) =>
		graph.degree[b] - graph.degree[a] || (graph.ids[a] < graph.ids[b] ? -1 : 1);
	const regions: Region[] = members.map((list, group) => {
		list.sort(byDegree);
		const hub = list[0];
		if (groupBy === "folder") {
			const folder = topFolder(graph.ids[hub]);
			return { group, name: folder || "(vault root)", members: list, anchors: [], folder };
		}
		return { group, name: graph.names[hub], members: list, anchors: list.slice(0, ANCHORS).map((i) => graph.ids[i]) };
	});
	if (orphans.length) regions.push({ group: -1, name: "Orphans", members: orphans.sort(byDegree), anchors: [] });
	return regions;
}

/** Cor escolhida na legenda para uma região. */
export interface RegionColor {
	color: string;
	/** Agrupado por pasta: a pasta de topo. */
	folder?: string;
	/** Agrupado por links: as notas mais conectadas da região quando ela foi pintada. */
	anchors?: string[];
	/** As notas órfãs (qualquer agrupamento). */
	orphans?: boolean;
}

/**
 * Em que região cada cor salva cai agora: pela pasta, pelas órfãs ou pela região que contém a maioria
 * das âncoras ainda existentes. Cores que disputam a mesma região: vence a última da lista.
 * @returns a cor de cada região e, para cada cor salva, a região encontrada (null = não encontrada).
 */
export function matchRegionColors(
	graph: GraphCore,
	regions: Region[],
	saved: RegionColor[],
	groupBy: GroupBy,
): { byGroup: Map<number, string>; found: (number | null)[] } {
	const index = new Map(graph.ids.map((id, i) => [id, i]));
	const byFolder = new Map(regions.filter((r) => r.folder !== undefined).map((r) => [r.folder!, r.group]));
	const hasOrphans = regions.some((r) => r.group < 0);
	const byGroup = new Map<number, string>();
	const found = saved.map((rc): number | null => {
		const color = normalizeHex(rc.color);
		if (!color) return null;
		let group: number | null = null;
		if (rc.orphans) group = hasOrphans ? -1 : null;
		else if (groupBy === "folder" && rc.folder !== undefined) group = byFolder.get(rc.folder) ?? null;
		else if (groupBy === "links" && rc.anchors?.length) {
			const votes = new Map<number, number>();
			for (const id of rc.anchors) {
				const i = index.get(id);
				const g = i === undefined ? -1 : graph.group[i];
				if (g >= 0) votes.set(g, (votes.get(g) ?? 0) + 1);
			}
			let best = 0;
			for (const [g, v] of votes) if (v > best || (v === best && group !== null && g < group)) [best, group] = [v, g];
		}
		if (group !== null) byGroup.set(group, color);
		return group;
	});
	return { byGroup, found };
}

/** A cor salva que identifica a região agora (para gravar ao pintar na legenda). */
export function regionKey(region: Region, color: string): RegionColor {
	if (region.group < 0) return { color, orphans: true };
	if (region.folder !== undefined) return { color, folder: region.folder };
	return { color, anchors: region.anchors };
}

// ---------- Regras por pasta e tag ----------

export interface ColorRule {
	kind: "folder" | "tag";
	value: string;
	color: string;
}

/** Pasta sem barras nas pontas; tag em minúsculas, sem "#". */
export function normalizeRuleValue(kind: ColorRule["kind"], value: string): string {
	const v = value.trim();
	return kind === "folder" ? v.replace(/^\/+|\/+$/g, "") : v.replace(/^#+/, "").toLowerCase();
}

/** A regra vale para a nota? Pasta inclui subpastas; tag inclui tags aninhadas (#a vale para #a/b). */
export function ruleMatches(rule: ColorRule, path: string, tags: readonly string[]): boolean {
	const value = normalizeRuleValue(rule.kind, rule.value);
	if (!value) return false;
	if (rule.kind === "folder") return path.startsWith(value + "/");
	return tags.some((t) => {
		const tag = t.replace(/^#+/, "").toLowerCase();
		return tag === value || tag.startsWith(value + "/");
	});
}

export interface NoteInfo {
	path: string;
	/** Tags da nota (com ou sem "#"). */
	tags: readonly string[];
	/** Valor da propriedade de cor no frontmatter, se houver. */
	property?: unknown;
}

/**
 * Cores por nota: propriedade do frontmatter > primeira regra que casa.
 * @returns índice do nó -> hex, só para as notas com cor própria.
 */
export function resolveNoteColors(notes: NoteInfo[], rules: ColorRule[]): Map<number, string> {
	const valid = rules
		.map((r) => ({ ...r, color: normalizeHex(r.color) }))
		.filter((r): r is ColorRule => r.color !== null);
	const out = new Map<number, string>();
	notes.forEach((note, i) => {
		const own = normalizeHex(note.property);
		if (own) {
			out.set(i, own);
			return;
		}
		const rule = valid.find((r) => ruleMatches(r, note.path, note.tags));
		if (rule) out.set(i, rule.color);
	});
	return out;
}
