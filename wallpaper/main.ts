// Wallpaper Engine: renderiza o BrainRenderer em tela cheia com um grafo demo e áudio reativo.
import { mulberry32 } from "../src/brain-shape";
import { buildGraphCore, type LinkMap } from "../src/graph-core";
import { BrainRenderer } from "../src/renderer";
import { resolveTheme } from "../src/theme";
import type { PaletteId } from "../src/colors";

// O renderer usa helpers de DOM que o Obsidian adiciona; fora dele, um polyfill mínimo.
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl ??= function (this: HTMLElement, tag: string, o?: { cls?: string }) {
	const el = document.createElement(tag);
	if (o?.cls) el.className = o.cls;
	return this.appendChild(el);
};
proto.createDiv ??= function (this: HTMLElement, o?: { cls?: string }) {
	return (this as unknown as { createEl(t: string, o?: { cls?: string }): HTMLElement }).createEl("div", o);
};

const params = new URLSearchParams(location.search);

/** Grafo sintético em regiões (usado enquanto não há vault conectado). */
function demoGraph(n: number, clusters: number) {
	const rng = mulberry32(99);
	const paths: string[] = [];
	const links: LinkMap = {};
	for (let i = 0; i < n; i++) paths.push(`Regiao${i % clusters}/Nota ${i}.md`);
	for (let i = 0; i < n; i++) {
		if (rng() < 0.08) continue;
		const out: Record<string, number> = {};
		const k = 1 + Math.floor(rng() * rng() * 6);
		for (let j = 0; j < k; j++) {
			let t = rng() < 0.85 ? Math.floor(rng() * (n / clusters)) * clusters + (i % clusters) : Math.floor(rng() * n);
			t = Math.min(n - 1, t);
			if (rng() < 0.15) t = (i % clusters) * 3;
			out[paths[t]] = 1;
		}
		links[paths[i]] = out;
	}
	return buildGraphCore(paths, links, { groupBy: "links", includeOrphans: true });
}

const wrap = document.getElementById("wrap")!;
const stage = document.getElementById("stage")!;
const brain = new BrainRenderer(
	stage,
	{ mode: "3d", showCortex: true, nodeSize: 1, hubLabels: false, glow: true, hoverPulses: false, ambientPulses: true, ambientCount: 45, idleAnimation: true, surface: false, dof: true, idleOrbit: true },
	{},
);
// Por padrão o mouse não mexe na câmera nem destaca nós (propriedade "mouse").
brain.setInteractive(false);
// Vista lateral levemente de baixo para cima (a órbita mantém a altura).
brain.setCameraDirection(1, -0.28, 0.02);

function applyPalette(id: PaletteId): void {
	brain.setTheme(resolveTheme("dark", wrap, id));
}

brain.setGraph(demoGraph(Number(params.get("n") ?? 250), 14));
window.addEventListener("resize", () => brain.resize());

// --- Áudio -----------------------------------------------------------------
// O Wallpaper Engine entrega 128 amostras (64 por canal) a ~30 Hz.
let audioGain = 1;
let level = 0;
let bassAvg = 0;
let lastKick = 0;

function onAudio(samples: ArrayLike<number>): void {
	let bass = 0;
	let all = 0;
	for (let i = 0; i < 6; i++) bass += samples[i] + samples[64 + i];
	for (let i = 0; i < 64; i++) all += samples[i] + samples[64 + i];
	bass /= 12;
	all /= 128;
	const target = Math.min(1, (bass * 0.6 + all * 1.6) * audioGain);
	level += (target - level) * (target > level ? 0.5 : 0.12);
	brain.setAudioLevel(level);
	const now = performance.now();
	// Batida: o grave passa bem acima da média recente.
	if (bass * audioGain > 0.25 && bass > bassAvg * 1.5 && now - lastKick > 350) {
		lastKick = now;
		brain.burst();
		brain.kick(Math.min(1, bass * audioGain * 1.5));
	}
	bassAvg += (bass - bassAvg) * 0.08;
}

// --- Propriedades do usuário (project.json) -------------------------------------
type Prop = { value: string | number | boolean };
const w = window as unknown as {
	wallpaperPropertyListener?: unknown;
	wallpaperRegisterAudioListener?: (cb: (a: number[]) => void) => void;
};
w.wallpaperPropertyListener = {
	applyUserProperties(props: Record<string, Prop>) {
		if (props.palette) applyPalette(String(props.palette.value) as PaletteId);
		if (props.audiogain) audioGain = Number(props.audiogain.value);
		if (props.glow) brain.setOptions({ glow: !!props.glow.value });
		if (props.orbit) brain.setOptions({ idleOrbit: !!props.orbit.value });
		if (props.surface) brain.setOptions({ surface: !!props.surface.value });
		if (props.mouse) brain.setInteractive(!!props.mouse.value);
	},
};
w.wallpaperRegisterAudioListener?.(onAudio);

// Fora do Wallpaper Engine (navegador): ?audio=1 simula uma batida para testar.
if (params.has("audio") && !w.wallpaperRegisterAudioListener) {
	setInterval(() => {
		const beat = (performance.now() / 500) % 1 < 0.1 ? 0.8 : 0.1;
		onAudio(Array.from({ length: 128 }, (_, i) => (i % 64 < 6 ? beat : beat * 0.3)));
	}, 33);
}
