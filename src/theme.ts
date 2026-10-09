import { AdditiveBlending, Color, LinearSRGBColorSpace, NormalBlending, type Blending } from "three";
import { ShellKind, type Shell, type SurfaceMesh, type Vec3 } from "./brain-shape";

export type ThemeKind = "dark" | "light";

/** Todas as cores da cena num lugar só: trocar de tema não refaz layout nem geometria. */
export interface BrainTheme {
	kind: ThemeKind;
	/** Fundo: clear color, névoa, para onde nós esmaecidos/desfocados e links fracos tendem. */
	bg: Color;
	/** Onda de repouso e cintilar das reações em cadeia. */
	flash: Color;
	/** Para onde a cor dos pulsos é puxada (mais claro no escuro). */
	pulseTint: Color;
	/** Halos e pulsos: somam luz no escuro; no claro são uma aura translúcida. */
	glowBlending: Blending;
	/** Brilho da borda de cada nó (anel mais escuro que dá contorno). */
	nodeRing: number;
	/** Multiplica a opacidade de halos e pulsos. */
	glowGain: number;
	/** Para onde os links fracos esmaecem (no escuro, o próprio fundo). */
	edgeFade: Color;
	/** Multiplica a intensidade dos links fora de foco (limitada à cor cheia). */
	edgeGain: number;
	edgeOpacity: number;
	/** Contorno da superfície do cérebro (somado nas bordas). */
	rim: Color;
	/** Cores das regiões, na ordem do tamanho (maior região = 0). */
	palette: string[];
	/**
	 * Os shaders de pontos escrevem a cor sem converter linear -> sRGB. Com `displayPalette`, o hex
	 * é usado como está e o nó mostra exatamente essa cor; sem ele (escuro, visual original), o hex
	 * é convertido para linear e o nó aparece mais escuro e saturado que o hex.
	 */
	displayPalette: boolean;
	/** Luminosidade das regiões além da paleta (matiz pelo ângulo de ouro). */
	extraLightness: number;
	orphan: Color;
	/*
	 * Os vetores abaixo vão direto para shaders que não convertem a cor: são valores de tela (sRGB).
	 * Já `edgeFade` vai para os links (LineBasicMaterial), que convertem: é linear.
	 */
	/** Matiz de cada lobo, na ordem de LOBES (sulcos e superfície do córtex). */
	lobeTint: Vec3[];
	/** Pontos da anatomia (contorno do córtex, cerebelo, medula). */
	shell: { boundary: Vec3; sulcusGain: number; cerebellum: Vec3; spine: Vec3 };
	/** Malhas da superfície: córtex = base + matiz do lobo × ganho. */
	anatomy: { cortexBase: Vec3; cortexGain: number; cerebellum: Vec3; spine: Vec3 };
}

/** Fundo padrão do escuro quando o tema do Obsidian não informa um (ou o escuro é forçado num tema claro). */
export const DARK_BG = "#070a12";

/** Fundo somado a um tom: a anatomia acompanha o fundo do tema em vez de impor uma cor própria. */
function lift(bg: Color, add: Vec3): Vec3 {
	return [bg.r + add[0], bg.g + add[1], bg.b + add[2]];
}

/**
 * Luz sobre o fundo do tema: superfície um pouco acima do fundo, contornos claros,
 * regiões em tons luminosos e brilhos somados (aditivos).
 */
export function darkTheme(bg: Color = new Color(DARK_BG)): BrainTheme {
	return {
		kind: "dark",
		bg,
		edgeFade: bg.clone(),
		edgeGain: 1,
		edgeOpacity: 0.55,
		flash: new Color(0.75, 0.92, 1.0),
		pulseTint: new Color(1, 1, 1),
		glowBlending: AdditiveBlending,
		nodeRing: 0.6,
		glowGain: 1,
		rim: new Color(0.22, 0.23, 0.26),
		displayPalette: false,
		palette: [
			"#5eead4", "#a78bfa", "#f472b6", "#60a5fa", "#fbbf24", "#34d399",
			"#fb7185", "#38bdf8", "#c084fc", "#f59e0b", "#4ade80", "#e879f9",
		],
		extraLightness: 0.62,
		orphan: new Color("#8391b0"),
		// frontal, parietal, occipital, temporal
		lobeTint: [
			[0.34, 0.44, 0.78],
			[0.3, 0.6, 0.66],
			[0.42, 0.58, 0.46],
			[0.56, 0.44, 0.72],
		],
		shell: {
			boundary: [0.72, 0.76, 0.84],
			sulcusGain: 0.62,
			cerebellum: [0.42, 0.45, 0.58],
			spine: [0.36, 0.39, 0.5],
		},
		anatomy: {
			cortexBase: lift(bg, [0.045, 0.046, 0.05]),
			cortexGain: 0.05,
			cerebellum: lift(bg, [0.075, 0.078, 0.088]),
			spine: lift(bg, [0.065, 0.068, 0.078]),
		},
	};
}

/** Cores dos pontos da anatomia. `out` permite repintar o atributo existente. */
/** Fundo padrão do claro quando o tema do Obsidian não informa um. */
export const LIGHT_BG = "#f7f8fb";

/**
 * Ilustração anatômica em papel: fundo do tema, superfície de porcelana com bordas escurecendo,
 * contornos em grafite e regiões em tons saturados (que não somem no branco).
 */
export function lightTheme(bg: Color = new Color(LIGHT_BG)): BrainTheme {
	return {
		kind: "light",
		bg,
		// Cinza médio (linear: os links convertem para sRGB): link fraco não vira risco branco.
		edgeFade: new Color(0.16, 0.17, 0.2),
		edgeGain: 1.5,
		edgeOpacity: 0.8,
		// Onda de repouso em azul suave, exibido como o hex (os pontos não convertem a cor).
		flash: new Color().setStyle("#7da7f5", LinearSRGBColorSpace),
		pulseTint: new Color("#0f172a"),
		glowBlending: NormalBlending,
		nodeRing: 0.7,
		glowGain: 1.6,
		// Negativo: a borda da superfície escurece em vez de brilhar.
		rim: new Color(-0.22, -0.2, -0.14),
		// Tons pastel (400), exibidos como estão; o anel do nó dá o contorno.
		displayPalette: true,
		palette: [
			"#2dd4bf", "#a78bfa", "#f472b6", "#60a5fa", "#f59e0b", "#34d399",
			"#fb7185", "#38bdf8", "#c084fc", "#fb923c", "#4ade80", "#e879f9",
		],
		extraLightness: 0.6,
		orphan: new Color().setStyle("#94a3b8", LinearSRGBColorSpace),
		// Lobos dessaturados: os sulcos ficam em grafite levemente tingido, sem azul-marinho pesado.
		lobeTint: [
			[0.42, 0.47, 0.64],
			[0.4, 0.55, 0.58],
			[0.46, 0.54, 0.48],
			[0.53, 0.47, 0.61],
		],
		shell: {
			boundary: [0.32, 0.34, 0.4],
			sulcusGain: 0.72,
			cerebellum: [0.44, 0.46, 0.52],
			spine: [0.44, 0.46, 0.52],
		},
		// Porcelana: clara o bastante para os nós em tom pastel se destacarem; a borda escurece pelo rim.
		anatomy: {
			cortexBase: [0.78, 0.785, 0.8],
			cortexGain: 0.06,
			cerebellum: [0.74, 0.75, 0.77],
			spine: [0.72, 0.73, 0.75],
		},
	};
}

export type Appearance = "auto" | ThemeKind;

/** Tema do Obsidian em vigor no documento (a view pode estar numa janela destacada). */
export function obsidianThemeKind(doc: Document): ThemeKind {
	return doc.body.classList.contains("theme-dark") ? "dark" : "light";
}

/**
 * Fundo do tema do Obsidian. A variável pode vir em qualquer formato (hex, hsl(), oklch(), lab(),
 * color-mix()…), e a cor computada mantém o formato moderno (oklch() sai como oklch()). Por isso o
 * próprio navegador converte: a cor é pintada num pixel de canvas e o RGB é lido de volta.
 */
export function obsidianBackground(el: HTMLElement, fallback: string): Color {
	const probe = el.createDiv({ cls: "brain-graph-bg-probe" });
	const value = getComputedStyle(probe).backgroundColor;
	// O canvas nasce dentro da sonda (mesmo documento da view) e continua usável depois de removido.
	const canvas = probe.createEl("canvas");
	probe.remove();
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return new Color(fallback);
	ctx.canvas.width = ctx.canvas.height = 1;
	// Valor inválido é ignorado pelo canvas: começar transparente faz ele cair no padrão.
	ctx.fillStyle = "rgba(0, 0, 0, 0)";
	ctx.fillStyle = value;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	// Transparente (variável ausente ou inválida): usa o padrão do modo.
	if (a === 0) return new Color(fallback);
	return new Color().setRGB(r / 255, g / 255, b / 255, "srgb");
}

/** Modo escolhido contrário ao do Obsidian (a interface não pode usar as cores do tema). */
export function isForced(appearance: Appearance, el: HTMLElement): boolean {
	return appearance !== "auto" && appearance !== obsidianThemeKind(el.ownerDocument);
}

export function resolveTheme(appearance: Appearance, el: HTMLElement): BrainTheme {
	const obsidian = obsidianThemeKind(el.ownerDocument);
	const kind = appearance === "auto" ? obsidian : appearance;
	// Modo forçado contrário ao do Obsidian: o fundo do tema não serve, usa o padrão do modo.
	if (kind === "dark") return darkTheme(obsidian === "dark" ? obsidianBackground(el, DARK_BG) : new Color(DARK_BG));
	return lightTheme(obsidian === "light" ? obsidianBackground(el, LIGHT_BG) : new Color(LIGHT_BG));
}

export function shellColors(
	shell: Shell,
	theme: BrainTheme,
	out: Float32Array<ArrayBufferLike> = new Float32Array(shell.kind.length * 3),
): Float32Array<ArrayBufferLike> {
	const { boundary, sulcusGain, cerebellum, spine } = theme.shell;
	for (let i = 0; i < shell.kind.length; i++) {
		const o = i * 3;
		const kind: ShellKind = shell.kind[i];
		switch (kind) {
			case ShellKind.Boundary:
				out.set(boundary, o);
				break;
			case ShellKind.Sulcus: {
				const t = theme.lobeTint[shell.lobe[i]];
				out[o] = t[0] * sulcusGain;
				out[o + 1] = t[1] * sulcusGain;
				out[o + 2] = t[2] * sulcusGain;
				break;
			}
			case ShellKind.Cerebellum:
				out.set(cerebellum, o);
				break;
			default: {
				const f = shell.fade[i];
				out[o] = spine[0] * f;
				out[o + 1] = spine[1] * f;
				out[o + 2] = spine[2] * f;
			}
		}
	}
	return out;
}

/** Cores por vértice de uma malha da anatomia. `out` permite repintar o atributo existente. */
export function meshColors(
	mesh: SurfaceMesh,
	theme: BrainTheme,
	out: Float32Array<ArrayBufferLike> = new Float32Array(mesh.positions.length),
): Float32Array<ArrayBufferLike> {
	const a = theme.anatomy;
	const n = mesh.positions.length / 3;
	for (let i = 0; i < n; i++) {
		const o = i * 3;
		if (mesh.part === "cortex") {
			const t = theme.lobeTint[mesh.lobe![i]];
			out[o] = a.cortexBase[0] + t[0] * a.cortexGain;
			out[o + 1] = a.cortexBase[1] + t[1] * a.cortexGain;
			out[o + 2] = a.cortexBase[2] + t[2] * a.cortexGain;
		} else if (mesh.part === "cerebellum") {
			out.set(a.cerebellum, o);
		} else {
			const f = mesh.fade![i];
			out[o] = a.spine[0] * f;
			out[o + 1] = a.spine[1] * f;
			out[o + 2] = a.spine[2] * f;
		}
	}
	return out;
}

export function groupColor(theme: BrainTheme, group: number): Color {
	if (group < 0) return theme.orphan.clone();
	if (group < theme.palette.length)
		return theme.displayPalette
			? new Color().setStyle(theme.palette[group], LinearSRGBColorSpace)
			: new Color(theme.palette[group]);
	return new Color().setHSL(((group * 137.508) % 360) / 360, 0.7, theme.extraLightness);
}
