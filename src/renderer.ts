import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	Color,
	DoubleSide,
	Fog,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
	Mesh,
	MOUSE,
	OrthographicCamera,
	PerspectiveCamera,
	Points,
	Scene,
	ShaderMaterial,
	TOUCH,
	Vector3,
	WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
	HEMI_CENTER,
	anatomyMeshes,
	cerebellumCenter,
	cortexRadius,
	mulberry32,
	sampleShell,
} from "./brain-shape";
import type { GraphCore } from "./graph-core";
import { BrainLayout, type SavedPosition } from "./layout";

export type ViewMode = "3d" | "2d";
export type ViewPreset = "lateral" | "superior" | "frontal";

export interface RenderOptions {
	mode: ViewMode;
	showCortex: boolean;
	nodeSize: number;
	hubLabels: boolean;
	/** Halo suave em volta dos nós. */
	glow: boolean;
	/** Sinais correndo pelos links da nota sob o mouse. */
	hoverPulses: boolean;
	/** Sinais lentos percorrendo o cérebro o tempo todo. */
	ambientPulses: boolean;
	ambientCount: number;
	/** Onda de atividade e respiração sutis quando ninguém está mexendo. */
	idleAnimation: boolean;
	/**
	 * Superfície do cérebro semitransparente (notas por fora, links em arco) ou
	 * nuvem de pontos transparente (notas dentro do córtex, links mergulhando para o centro).
	 */
	surface: boolean;
	/** Profundidade de campo: o que está atrás do centro do cérebro fica desfocado e esmaecido. */
	dof: boolean;
	/** Em repouso, a câmera orbita lentamente o cérebro. */
	idleOrbit: boolean;
}

export interface RendererCallbacks {
	onNodeClick?: (index: number, evt: MouseEvent) => void;
	/** Medidor de desempenho: chamado ~2x por segundo enquanto há frames sendo desenhados. */
	onStats?: (stats: FrameStats) => void;
	/** O layout terminou de se acomodar (`moved` = false se tudo veio pronto do cache). */
	onLayoutSettled?: (moved: boolean) => void;
	/** Entrou/saiu da "tela de descanso" (para a view esmaecer a interface). */
	onRestChange?: (resting: boolean) => void;
}

export interface FrameStats {
	fps: number;
	/** Tempo de CPU médio por frame (ms). */
	cpuMs: number;
	/** Pior intervalo entre frames na janela (ms). */
	worstGapMs: number;
	bufferWidth: number;
	bufferHeight: number;
}

const TARGET = new Vector3(0, -0.08, 0);
const PRESETS: Record<ViewPreset, [number, number, number]> = {
	lateral: [1, 0.08, 0.02],
	superior: [0, 1, -0.01],
	frontal: [0.02, 0.08, 1],
};
const CAMERA_DISTANCE = 3.5;
const ORTHO_HALF_HEIGHT = 1.15;
const BG = new Color("#070a12");
const PALETTE = [
	"#5eead4", "#a78bfa", "#f472b6", "#60a5fa", "#fbbf24", "#34d399",
	"#fb7185", "#38bdf8", "#c084fc", "#f59e0b", "#4ade80", "#e879f9",
];
const ORPHAN_COLOR = new Color("#8391b0");
/** Segmentos por aresta: links longos curvam para o centro (substância branca). */
const EDGE_SEGMENTS = 6;
/** Centro usado para arcos entre hemisférios (passam por cima da fissura). */
const MIDLINE = [0, HEMI_CENTER[1], HEMI_CENTER[2]];
/** Modo nuvem: links longos mergulham para este ponto (substância branca). */
const FIBER_CENTER = [0, 0.05, -0.1];
/**
 * O layout guarda as notas logo acima da superfície. No modo nuvem elas são aproximadas do centro
 * na hora de desenhar (ficam dentro do córtex / cerebelo); as posições salvas não mudam.
 */
const CLOUD_CORTEX_SCALE = 0.88;
const CLOUD_CEREB_SCALE = 0.7;
/** Opacidade da superfície do cérebro: deixa o lado de trás levemente visível. */
const SURFACE_OPACITY = 0.85;

const SURFACE_VERT = /* glsl */ `
attribute vec3 aColor;
uniform float uOrtho;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vColor;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	vNormal = normalize(normalMatrix * normal);
	vView = uOrtho > 0.5 ? vec3(0.0, 0.0, 1.0) : normalize(-mv.xyz);
	vColor = aColor;
	gl_Position = projectionMatrix * mv;
}`;

// Sombreamento de "farol" (luz vinda da câmera) + contorno suave nas bordas: dá volume sem luzes na cena.
const SURFACE_FRAG = /* glsl */ `
uniform float uOpacity;
uniform float uRim;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vColor;
void main() {
	float ndv = abs(dot(normalize(vNormal), normalize(vView)));
	vec3 c = vColor * (0.45 + 0.8 * ndv) + vec3(0.2, 0.28, 0.46) * pow(1.0 - ndv, 2.5) * 0.5 * uRim;
	gl_FragColor = vec4(c, uOpacity);
}`;

/** Teto de pixels do framebuffer (~1080p). Acima disso o custo de fill cresce sem ganho visível. */
const PIXEL_BUDGET = 1.6e6;
const MAX_POINT_PX = 28;
/** Teto do halo em px: limita o custo de preenchimento com zoom. */
const MAX_HALO_PX = 60;
/** Pulsos do hover: no máximo um por link, até este limite (os vizinhos mais conectados primeiro). */
const MAX_HOVER_PULSES = 40;
/** Pontos por pulso: cabeça + rastro curto. */
const PULSE_TRAIL = 4;
const TRAIL_STEP = 0.06;
/** Links por segundo percorridos por um pulso. */
const PULSE_SPEED = 0.25;
/** Limite de pulsos ambientes (a geometria é alocada uma vez com este tamanho). */
const AMBIENT_MAX = 150;
/** Quando só os pulsos ambientes animam, desenha no máximo a ~30 fps (ritmo estável, metade do custo). */
const AMBIENT_FRAME_MS = 31;
/** Intensidade dos pulsos ambientes (mais discretos que os do hover). */
const AMBIENT_INTENSITY = 0.45;
/** Tempo sem interação até a animação de repouso começar. */
const IDLE_DELAY_MS = 1500;
/** Órbita de repouso: rad/s (~90 s por volta). */
const IDLE_ORBIT_SPEED = 0.07;
/** Intervalo entre reações em cadeia na tela de descanso (s). */
const BURST_MIN_S = 2.5;
const BURST_MAX_S = 5;
/** Gerações de uma reação em cadeia (quantas vezes os vizinhos repassam o sinal). */
const BURST_GENERATIONS = 2;
/** Meta: nunca abaixo de 20 fps. O governador reduz a resolução se o frame passar disso. */
const SLOW_FRAME_MS = 50;

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aHighlight;
attribute float aFlash;
uniform float uScale;
uniform float uPixelRatio;
uniform float uOrtho;
uniform float uFocus;
uniform float uMinSize;
uniform float uMaxSize;
uniform float uSizeScale;
uniform float uTime;
uniform float uIdle;
uniform float uWave;
uniform float uDof;
uniform float uDofNear;
uniform float uDofFar;
uniform float uLodCull;
uniform vec3 uBg;
varying vec3 vColor;
varying float vDim;
varying float vBlur;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mv;
	// Profundidade de campo aproximada: 0 = em foco (frente), 1 = bem desfocado (fundo do cérebro).
	vBlur = uDof * smoothstep(uDofNear, uDofFar, -mv.z);
	float px = uOrtho > 0.5 ? aSize * uScale : aSize * uScale / max(-mv.z, 0.001);
	// Onda de atividade (repouso): faixa estreita que varre o cérebro de trás para a frente.
	float wave = pow(0.5 + 0.5 * sin(uTime * 0.55 - position.z * 2.2 - position.y * 0.8), 4.0) * uIdle * uWave;
	px *= (1.0 + aHighlight * 0.5) * uSizeScale * (1.0 + wave * 0.45 + aFlash * 0.9);
	gl_PointSize = clamp(px, uMinSize, uMaxSize) * (1.0 + vBlur * 1.6) * uPixelRatio;
	// LOD: halos e pulsos do fundo desfocado não são desenhados (zero custo de preenchimento).
	if (uLodCull > 0.5 && vBlur > 0.6) {
		gl_PointSize = 0.0;
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
	}
	vDim = uFocus * (1.0 - step(0.5, aHighlight));
	vColor = mix(mix(aColor, uBg, vDim * 0.8), vec3(0.75, 0.92, 1.0), clamp(wave * 0.55 + aFlash * 0.6, 0.0, 1.0));
}`;

const FRAG = /* glsl */ `
uniform vec3 uBg;
varying vec3 vColor;
varying float vBlur;
void main() {
	float r = length(gl_PointCoord - 0.5) * 2.0;
	// Em foco: disco nítido com anel escuro. Desfocado: borda larga e difusa, puxando para o fundo.
	// Bokeh: desfocado vira um disco maior, de opacidade baixa e uniforme, com borda suave.
	float edge = mix(0.12, 0.3, vBlur);
	float a = 1.0 - smoothstep(1.0 - edge, 1.0, r);
	if (a < 0.03) discard;
	vec3 col = (r > 0.75 && vBlur < 0.35) ? vColor * 0.6 : vColor;
	col = mix(col, uBg, vBlur * 0.6);
	gl_FragColor = vec4(col, a * mix(1.0, 0.32, vBlur));
}`;

/** Halo: queda suave do centro para a borda, somado à cena (aditivo). Some quando o nó está fora de foco. */
const HALO_FRAG = /* glsl */ `
uniform float uIntensity;
uniform float uBreath;
varying vec3 vColor;
varying float vDim;
varying float vBlur;
void main() {
	float d = length(gl_PointCoord - 0.5) * 2.0;
	if (d > 1.0) discard;
	float a = (1.0 - d) * (1.0 - d) * uIntensity * (1.0 + uBreath) * (1.0 - vDim * 0.85) * (1.0 - vBlur);
	gl_FragColor = vec4(vColor, a);
}`;

function pointMaterial(minSize: number, depthWrite: boolean): ShaderMaterial {
	return new ShaderMaterial({
		uniforms: {
			uScale: { value: 1 },
			uPixelRatio: { value: 1 },
			uOrtho: { value: 0 },
			uFocus: { value: 0 },
			uMinSize: { value: minSize },
			uMaxSize: { value: MAX_POINT_PX },
			uSizeScale: { value: 1 },
			uTime: { value: 0 },
			uIdle: { value: 0 },
			uWave: { value: 0 },
			uDof: { value: 0 },
			uDofNear: { value: 3 },
			uDofFar: { value: 4 },
			uLodCull: { value: 0 },
			uBg: { value: BG },
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		transparent: true,
		depthWrite,
	});
}

/** Pontos macios e aditivos para os pulsos (mesmo shader do halo, sem ampliar). */
function pulseMaterial(): ShaderMaterial {
	const m = haloMaterial();
	m.uniforms.uSizeScale.value = 1;
	m.uniforms.uMinSize.value = 3;
	m.uniforms.uMaxSize.value = 26;
	m.uniforms.uIntensity.value = 0.75;
	return m;
}

function haloMaterial(): ShaderMaterial {
	const m = pointMaterial(7, false);
	m.fragmentShader = HALO_FRAG;
	m.uniforms.uSizeScale.value = 2.3;
	m.uniforms.uMaxSize.value = MAX_HALO_PX;
	m.uniforms.uIntensity = { value: 0.2 };
	m.uniforms.uBreath = { value: 0 };
	m.transparent = true;
	m.blending = AdditiveBlending;
	return m;
}

function pointGeometry(positions: Float32Array, colors: Float32Array, size: Float32Array): BufferGeometry {
	const geo = new BufferGeometry();
	geo.setAttribute("position", new BufferAttribute(positions, 3));
	geo.setAttribute("aColor", new BufferAttribute(colors, 3));
	geo.setAttribute("aSize", new BufferAttribute(size, 1));
	geo.setAttribute("aHighlight", new BufferAttribute(new Float32Array(positions.length / 3), 1));
	geo.setAttribute("aFlash", new BufferAttribute(new Float32Array(positions.length / 3), 1));
	return geo;
}

export function groupColor(group: number): Color {
	if (group < 0) return ORPHAN_COLOR.clone();
	if (group < PALETTE.length) return new Color(PALETTE[group]);
	return new Color().setHSL(((group * 137.508) % 360) / 360, 0.7, 0.62);
}

/**
 * Renderer enxuto: desenha só quando algo muda (câmera, hover, layout convergindo).
 * Parado, não consome GPU nem CPU.
 */
export class BrainRenderer {
	private readonly renderer: WebGLRenderer;
	private readonly scene = new Scene();
	private readonly persp = new PerspectiveCamera(40, 1, 0.05, 50);
	private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0.05, 50);
	private controls!: OrbitControls;
	private readonly labelLayer: HTMLDivElement;
	private readonly labelPool: HTMLDivElement[] = [];

	private readonly shell: Points;
	private readonly shellMat = pointMaterial(1, true);
	private readonly surfaces: Mesh[] = [];
	private readonly surfaceMat = new ShaderMaterial({
		uniforms: { uOrtho: { value: 0 }, uOpacity: { value: SURFACE_OPACITY }, uRim: { value: 1 } },
		vertexShader: SURFACE_VERT,
		fragmentShader: SURFACE_FRAG,
		side: DoubleSide,
		transparent: true,
		depthWrite: true,
	});
	private readonly cerebCenter = cerebellumCenter();
	private readonly fog = new Fog(BG, 3, 4);
	private readonly nodeMat = pointMaterial(2.5, true);
	private readonly haloMat = haloMaterial();
	private readonly edgeMat = new LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.55,
		depthWrite: true,
	});

	private graph?: GraphCore;
	private layout?: BrainLayout;
	private nodes?: Points;
	/** Posições de exibição (layout ajustado ao modo superfície/nuvem). */
	private view = new Float32Array(0);
	/** Compartilha a geometria dos nós; só muda o material. */
	private halo?: Points;
	private readonly pulseMat = pulseMaterial();
	private readonly pulses: Points;
	/** Aresta, sentido (1 = percorre de b para a) e fase de cada pulso ativo. */
	private readonly pulseEdge = new Int32Array(MAX_HOVER_PULSES);
	private readonly pulseDir = new Uint8Array(MAX_HOVER_PULSES);
	private readonly pulseT = new Float32Array(MAX_HOVER_PULSES);
	private pulseCount = 0;
	private readonly ambientMat = pulseMaterial();
	private readonly ambient: Points;
	private readonly ambEdge = new Int32Array(AMBIENT_MAX);
	private readonly ambDir = new Uint8Array(AMBIENT_MAX);
	private readonly ambT = new Float32Array(AMBIENT_MAX);
	private readonly ambSpeed = new Float32Array(AMBIENT_MAX);
	private ambCount = 0;
	/** Pulso vivo (visível) e geração restante (0 = pulso ambiente comum; >0 = reação em cadeia). */
	private readonly ambAlive = new Uint8Array(AMBIENT_MAX);
	private readonly ambGen = new Uint8Array(AMBIENT_MAX);
	private burstTimer = BURST_MIN_S;
	private burstCursor = 0;
	/** Brilho de cada neurônio (atributo aFlash dos nós) e o alvo que ele persegue. */
	private flash: Float32Array = new Float32Array(0);
	private flashTarget = new Float32Array(0);
	private resting = false;
	private ambLast = 0;
	private readonly ambRng = mulberry32(11);
	private readonly ambColor = new Color();
	/** Frame pedido por interação/mudança (desenha já) vs. continuação de animação (pode esperar o ritmo de 30 fps). */
	private urgent = true;
	private lastRender = 0;
	/** 0 = interagindo, 1 = em repouso (transição suave). */
	private idleMix = 0;
	private idleTime = 0;
	private idleLast = 0;
	private lastInteraction = 0;
	private pulseLast = 0;
	private readonly pulseColor = new Color();
	private edges?: LineSegments;
	private colors: Color[] = [];
	private edgeBase = new Float32Array(0);
	private edgeCtrl = new Float32Array(0);
	private edgeFocus = new Float32Array(0);
	private edgeLen = new Float32Array(0);
	private hubs: number[] = [];

	private fit = 1;
	private hover = -1;
	private active = -1;
	private search: number[] = [];
	private labelSet: { i: number; cls: string }[] = [];

	private width = 1;
	private height = 1;
	/** Multiplicador de resolução ajustado pelo governador de fps. */
	private quality = 1;
	private slowFrames = 0;
	private mouseX = 0;
	private mouseY = 0;
	private mouseInside = false;
	private pickDirty = false;
	private dragging = false;
	private downX = 0;
	private downY = 0;
	private raf = 0;
	private lastFrame = 0;
	private disposed = false;
	private visible = true;
	private readonly observer: IntersectionObserver;
	private readonly tmp = new Vector3();
	private readonly viewProj = new Matrix4();
	private readonly pt = [0, 0, 0];
	private statStart = 0;
	private statFrames = 0;
	private statCpu = 0;
	private statWorst = 0;
	private statLast = 0;
	private idleTimer = 0;

	constructor(
		private readonly container: HTMLElement,
		private opts: RenderOptions,
		private readonly callbacks: RendererCallbacks = {},
	) {
		this.renderer = new WebGLRenderer({ antialias: false, alpha: false, stencil: false });
		this.renderer.setClearColor(BG, 1);
		container.appendChild(this.renderer.domElement);

		this.labelLayer = document.createElement("div");
		this.labelLayer.className = "brain-graph-labels";
		container.appendChild(this.labelLayer);

		const shell = sampleShell(mulberry32(3));
		const shellSize = new Float32Array(shell.positions.length / 3).fill(0.007);
		this.shell = new Points(pointGeometry(shell.positions, shell.colors, shellSize), this.shellMat);
		this.shell.frustumCulled = false;
		this.shell.renderOrder = 0;
		// Intensidade da onda de repouso por camada: marcos anatômicos um pouco mais que os nós.
		this.shellMat.uniforms.uWave.value = 2.0;
		this.nodeMat.uniforms.uWave.value = 1.0;
		this.haloMat.uniforms.uWave.value = 1.2;
		for (const m of [this.haloMat, this.pulseMat, this.ambientMat]) m.uniforms.uLodCull.value = 1;

		// Superfície quase opaca. Ordem de desenho: nós e links (escrevem profundidade) -> superfície
		// (encobre 85% do que está atrás dela) -> halos e pulsos (os de trás ficam escondidos).
		for (const m of anatomyMeshes()) {
			const geo = new BufferGeometry();
			geo.setAttribute("position", new BufferAttribute(m.positions, 3));
			geo.setAttribute("aColor", new BufferAttribute(m.colors, 3));
			geo.setIndex(new BufferAttribute(m.indices, 1));
			geo.computeVertexNormals();
			const mesh = new Mesh(geo, this.surfaceMat);
			mesh.renderOrder = 5;
			this.surfaces.push(mesh);
			this.scene.add(mesh);
		}
		this.scene.add(this.shell);

		// Geometria dos pulsos alocada uma vez; só a quantidade desenhada muda.
		const pulsePts = MAX_HOVER_PULSES * PULSE_TRAIL;
		const pulseSize = new Float32Array(pulsePts);
		for (let p = 0; p < MAX_HOVER_PULSES; p++)
			for (let k = 0; k < PULSE_TRAIL; k++) pulseSize[p * PULSE_TRAIL + k] = 0.026 * (1 - (k / PULSE_TRAIL) * 0.6);
		const pulseGeo = pointGeometry(new Float32Array(pulsePts * 3), new Float32Array(pulsePts * 3), pulseSize);
		(pulseGeo.getAttribute("aHighlight") as BufferAttribute).array.fill(1); // nunca esmaecidos pelo foco
		this.pulses = new Points(pulseGeo, this.pulseMat);
		this.pulses.frustumCulled = false;
		this.pulses.renderOrder = 7;
		this.scene.add(this.pulses);

		const ambPts = AMBIENT_MAX * PULSE_TRAIL;
		const ambSize = new Float32Array(ambPts);
		for (let p = 0; p < AMBIENT_MAX; p++)
			for (let k = 0; k < PULSE_TRAIL; k++) ambSize[p * PULSE_TRAIL + k] = 0.022 * (1 - (k / PULSE_TRAIL) * 0.6);
		const ambGeo = pointGeometry(new Float32Array(ambPts * 3), new Float32Array(ambPts * 3), ambSize);
		(ambGeo.getAttribute("aHighlight") as BufferAttribute).array.fill(1);
		this.ambientMat.uniforms.uIntensity.value = AMBIENT_INTENSITY;
		this.ambient = new Points(ambGeo, this.ambientMat);
		this.ambient.frustumCulled = false;
		this.ambient.renderOrder = 7;
		this.scene.add(this.ambient);
		// Compila os shaders agora: sem isso, o 1º hover engasga (~30 ms) compilando o material dos pulsos.
		this.renderer.compile(this.scene, this.persp);
		this.pulses.visible = false;

		this.setupControls();
		this.resize();
		this.applyPreset("lateral");

		const el = this.renderer.domElement;
		el.addEventListener("pointermove", this.onPointerMove);
		el.addEventListener("pointerdown", this.onPointerDown);
		el.addEventListener("pointerup", this.onPointerUp);
		el.addEventListener("pointerleave", this.onPointerLeave);
		document.addEventListener("visibilitychange", this.requestFrame);

		this.observer = new IntersectionObserver((entries) => {
			this.visible = entries.some((e) => e.isIntersecting);
			if (this.visible) this.requestFrame();
		});
		this.observer.observe(container);

		this.applyOptions();
	}

	// ---------- API pública ----------

	setGraph(graph: GraphCore, prev?: Map<string, SavedPosition>): void {
		this.graph = graph;
		this.colors = Array.from({ length: graph.groupCount + 1 }, (_, k) => groupColor(k - 1));
		this.layout = new BrainLayout(graph, prev);
		this.hover = -1;
		this.pulseCount = 0;
		this.buildAmbient();
		this.search = [];
		this.active = -1;
		this.buildNodes();
		this.buildEdges();
		this.hubs = [...graph.degree.keys()]
			.filter((i) => graph.degree[i] >= 3)
			.sort((a, b) => graph.degree[b] - graph.degree[a])
			.slice(0, 10);
		this.refreshFocus();
		this.requestFrame();
		if (!this.layout.running) queueMicrotask(() => this.callbacks.onLayoutSettled?.(false));
	}

	/** Posições atuais por id ([x, y, z, órfã]), para reaproveitar o layout num rebuild ou salvar. */
	positionsById(): Map<string, number[]> {
		const out = new Map<string, number[]>();
		if (!this.graph || !this.layout) return out;
		const pos = this.layout.pos;
		const group = this.graph.group;
		this.graph.ids.forEach((id, i) =>
			out.set(id, [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], group[i] < 0 ? 1 : 0]),
		);
		return out;
	}

	setOptions(partial: Partial<RenderOptions>): void {
		const modeChanged = partial.mode !== undefined && partial.mode !== this.opts.mode;
		const sizeChanged = partial.nodeSize !== undefined && partial.nodeSize !== this.opts.nodeSize;
		const ambientChanged =
			(partial.ambientCount !== undefined && partial.ambientCount !== this.opts.ambientCount) ||
			(partial.ambientPulses !== undefined && partial.ambientPulses !== this.opts.ambientPulses);
		const surfaceChanged = partial.surface !== undefined && partial.surface !== this.opts.surface;
		this.opts = { ...this.opts, ...partial };
		if (modeChanged) {
			const dir = this.camera.position.clone().sub(this.controls.target).normalize();
			this.setupControls();
			this.placeCamera(dir);
		}
		if (sizeChanged) this.buildNodes();
		if (ambientChanged) this.buildAmbient();
		if (surfaceChanged) {
			this.syncView();
			this.syncEdgePositions();
		}
		this.setupPulses();
		this.applyOptions();
		this.refreshFocus();
		this.requestFrame();
	}

	setActive(index: number): void {
		this.active = index;
		this.refreshFocus();
		this.requestFrame();
	}

	setSearch(indices: number[]): void {
		this.search = indices;
		this.refreshFocus();
		this.requestFrame();
	}

	/** Interação fora do canvas (barra, busca, teclado): sai da tela de descanso. */
	wake(): void {
		this.markInteraction();
		this.requestFrame();
	}

	applyPreset(preset: ViewPreset): void {
		const [x, y, z] = PRESETS[preset];
		this.placeCamera(new Vector3(x, y, z).normalize());
		this.requestFrame();
	}

	resize(): void {
		const w = Math.max(1, this.container.clientWidth);
		const h = Math.max(1, this.container.clientHeight);
		// Guardado em cache: ler clientWidth dentro do loop força reflow.
		this.width = w;
		this.height = h;
		this.applyResolution();
		const aspect = w / h;
		this.persp.aspect = aspect;
		this.persp.updateProjectionMatrix();
		// Em painéis estreitos (retrato), afasta a câmera para o cérebro caber na largura.
		this.fit = Math.max(1, 1.15 / aspect);
		const half = ORTHO_HALF_HEIGHT * this.fit;
		this.ortho.left = -half * aspect;
		this.ortho.right = half * aspect;
		this.ortho.top = half;
		this.ortho.bottom = -half;
		this.ortho.updateProjectionMatrix();
		this.requestFrame();
	}

	dispose(): void {
		this.disposed = true;
		cancelAnimationFrame(this.raf);
		this.observer.disconnect();
		document.removeEventListener("visibilitychange", this.requestFrame);
		const el = this.renderer.domElement;
		el.removeEventListener("pointermove", this.onPointerMove);
		el.removeEventListener("pointerdown", this.onPointerDown);
		el.removeEventListener("pointerup", this.onPointerUp);
		el.removeEventListener("pointerleave", this.onPointerLeave);
		this.controls.dispose();
		for (const obj of [this.shell, this.nodes, this.edges, ...this.surfaces]) obj?.geometry.dispose();
		this.surfaceMat.dispose();
		this.pulses.geometry.dispose();
		this.ambient.geometry.dispose();
		this.ambientMat.dispose();
		for (const m of [this.shellMat, this.nodeMat, this.haloMat, this.pulseMat, this.edgeMat]) m.dispose();
		this.renderer.dispose();
		this.renderer.forceContextLoss();
		el.remove();
		this.labelLayer.remove();
	}

	// ---------- Cena ----------

	private color(group: number): Color {
		return this.colors[group + 1];
	}

	private get camera(): PerspectiveCamera | OrthographicCamera {
		return this.opts.mode === "3d" ? this.persp : this.ortho;
	}

	/** Resolução = min(DPR, 1, orçamento de pixels) x qualidade do governador. */
	private applyResolution(): void {
		const budget = Math.sqrt(PIXEL_BUDGET / (this.width * this.height));
		const pr = Math.max(0.35, Math.min(window.devicePixelRatio || 1, 1, budget) * this.quality);
		this.renderer.setPixelRatio(pr);
		this.renderer.setSize(this.width, this.height);
	}

	private setupControls(): void {
		const target = this.controls ? this.controls.target.clone() : TARGET.clone();
		this.controls?.dispose();
		const c = new OrbitControls(this.camera, this.renderer.domElement);
		c.target.copy(target);
		// Sem amortecimento: a câmera para no instante em que o mouse para (sem frames extras).
		c.enableDamping = false;
		c.rotateSpeed = 0.7;
		c.zoomSpeed = 0.9;
		c.screenSpacePanning = true;
		if (this.opts.mode === "2d") {
			c.enableRotate = false;
			c.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
			c.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };
			c.minZoom = 0.5;
			c.maxZoom = 12;
		} else {
			c.minDistance = 0.5;
			c.maxDistance = 9;
		}
		c.addEventListener("change", this.requestFrame);
		c.addEventListener("change", this.markInteraction);
		c.addEventListener("start", this.onControlsStart);
		c.addEventListener("end", this.onControlsEnd);
		this.controls = c;
	}

	private placeCamera(dir: Vector3): void {
		const cam = this.camera;
		cam.position.copy(TARGET).addScaledVector(dir, CAMERA_DISTANCE * this.fit);
		cam.up.set(0, 1, 0);
		if (cam instanceof OrthographicCamera) {
			cam.zoom = 1;
			cam.updateProjectionMatrix();
		}
		this.controls.target.copy(TARGET);
		cam.lookAt(TARGET);
		this.controls.update();
	}

	private applyOptions(): void {
		this.shell.visible = this.opts.showCortex;
		const surface = this.opts.surface && this.opts.showCortex;
		for (const m of this.surfaces) m.visible = surface;
		// Com superfície, marcos e links escrevem profundidade (a superfície não os cobre na frente).
		this.shellMat.depthWrite = surface;
		this.edgeMat.depthWrite = surface;
		// Nuvem: nós transparentes (bordas difusas) desenhados por cima dos links.
		this.nodeMat.depthWrite = surface;
		if (this.nodes) this.nodes.renderOrder = surface ? 1 : 3;
		this.scene.fog = this.opts.dof ? this.fog : null;
		this.surfaceMat.uniforms.uOrtho.value = this.opts.mode === "2d" ? 1 : 0;
		const ortho = this.opts.mode === "2d" ? 1 : 0;
		for (const m of [this.shellMat, this.nodeMat, this.haloMat, this.pulseMat, this.ambientMat]) m.uniforms.uOrtho.value = ortho;
		if (this.halo) this.halo.visible = this.opts.glow;
	}

	private buildNodes(): void {
		const g = this.graph;
		const layout = this.layout;
		if (!g || !layout) return;
		if (this.nodes) {
			this.scene.remove(this.nodes);
			if (this.halo) this.scene.remove(this.halo);
			this.nodes.geometry.dispose();
		}
		const n = g.ids.length;
		const colors = new Float32Array(n * 3);
		const sizes = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			this.color(g.group[i]).toArray(colors, i * 3);
			sizes[i] = Math.min(0.09, 0.018 * this.opts.nodeSize * (0.8 + 0.4 * Math.sqrt(g.degree[i])));
		}
		this.view = new Float32Array(n * 3);
		this.syncView();
		this.nodes = new Points(pointGeometry(this.view, colors, sizes), this.nodeMat);
		this.flash = (this.nodes.geometry.getAttribute("aFlash") as BufferAttribute).array as Float32Array;
		this.flashTarget = new Float32Array(n);
		this.nodes.frustumCulled = false;
		this.nodes.renderOrder = this.opts.surface && this.opts.showCortex ? 1 : 3;
		this.scene.add(this.nodes);
		this.halo = new Points(this.nodes.geometry, this.haloMat);
		this.halo.frustumCulled = false;
		this.halo.renderOrder = 6;
		this.halo.visible = this.opts.glow;
		this.scene.add(this.halo);
	}

	private buildEdges(): void {
		const g = this.graph;
		if (!g) return;
		if (this.edges) {
			this.scene.remove(this.edges);
			this.edges.geometry.dispose();
		}
		const m = g.edges.length / 2;
		const verts = m * EDGE_SEGMENTS * 2;
		this.edgeBase = new Float32Array(m * 6);
		this.edgeCtrl = new Float32Array(m * 3);
		this.edgeFocus = new Float32Array(m).fill(1);
		this.edgeLen = new Float32Array(m);
		for (let e = 0; e < m; e++) {
			this.color(g.group[g.edges[e * 2]]).toArray(this.edgeBase, e * 6);
			this.color(g.group[g.edges[e * 2 + 1]]).toArray(this.edgeBase, e * 6 + 3);
		}
		const geo = new BufferGeometry();
		geo.setAttribute("position", new BufferAttribute(new Float32Array(verts * 3), 3));
		geo.setAttribute("color", new BufferAttribute(new Float32Array(verts * 3), 3));
		this.edges = new LineSegments(geo, this.edgeMat);
		this.edges.frustumCulled = false;
		this.edges.renderOrder = 2;
		this.scene.add(this.edges);
		this.syncEdgePositions();
	}

	// ---------- Loop sob demanda ----------

	/** Pedido por interação ou mudança: o próximo frame desenha sem esperar. */
	private readonly requestFrame = (): void => {
		this.urgent = true;
		if (this.disposed || this.raf) return;
		this.raf = requestAnimationFrame(this.frame);
	};

	/** Continuação de animação: pode ser adiada para manter o ritmo de ~30 fps em repouso. */
	private scheduleAnimation(): void {
		if (this.disposed || this.raf) return;
		this.raf = requestAnimationFrame(this.frame);
	}

	private readonly onControlsStart = (): void => {
		this.dragging = true;
		this.slowFrames = 0;
		this.lastFrame = 0;
	};

	private readonly onControlsEnd = (): void => {
		this.dragging = false;
		this.pickDirty = true;
		this.requestFrame();
	};

	private readonly frame = (now: number): void => {
		this.raf = 0;
		if (this.disposed || !this.visible || document.hidden) return;
		// Só pulsos ambientes animando (nada de interação, layout ou hover): segura a ~30 fps.
		const hoverAnimating = this.pulseCount > 0 && this.hover >= 0 && this.opts.hoverPulses;
		if (!this.urgent && !this.dragging && !this.layout?.running && !hoverAnimating && now - this.lastRender < AMBIENT_FRAME_MS) {
			this.raf = requestAnimationFrame(this.frame);
			return;
		}
		const t0 = performance.now();

		// Governador: durante arraste, se o intervalo entre frames passar de 50 ms (< 20 fps)
		// por alguns frames seguidos, reduz a resolução.
		if (this.dragging && this.lastFrame) {
			const gap = now - this.lastFrame;
			this.slowFrames = gap > SLOW_FRAME_MS ? this.slowFrames + 1 : 0;
			if (this.slowFrames >= 4 && this.quality > 0.4) {
				this.quality *= 0.8;
				this.slowFrames = 0;
				this.applyResolution();
			}
		}
		this.lastFrame = now;

		let keepGoing = false;
		if (this.layout?.running) {
			this.layout.stepFor(6);
			keepGoing = true;
			this.syncView();
			this.syncEdgePositions();
			if (!this.layout.running) this.callbacks.onLayoutSettled?.(true);
		}

		if (this.pickDirty && !this.dragging) this.pick();
		if (this.updatePulses(now)) keepGoing = true;
		if (this.updateAmbient(now)) keepGoing = true;
		if (this.updateIdle(now)) keepGoing = true;
		this.updateUniforms();
		this.renderer.render(this.scene, this.camera);
		this.updateLabels();
		this.urgent = false;
		this.lastRender = now;

		if (keepGoing) this.scheduleAnimation();
		this.recordStats(now, performance.now() - t0);
	};

	private recordStats(now: number, cpu: number): void {
		if (!this.callbacks.onStats) return;
		// Só mede sequências contínuas de frames (arrastar, zoom, layout); um frame isolado não conta.
		if (!this.statLast || now - this.statLast > 250) {
			this.statStart = now;
			this.statFrames = 0;
			this.statCpu = 0;
			this.statWorst = 0;
		} else {
			this.statWorst = Math.max(this.statWorst, now - this.statLast);
			this.statFrames++;
			this.statCpu += cpu;
		}
		this.statLast = now;
		const span = now - this.statStart;
		if (span >= 500 && this.statFrames > 0) {
			const gl = this.renderer.getContext();
			this.callbacks.onStats({
				fps: (this.statFrames * 1000) / span,
				cpuMs: this.statCpu / this.statFrames,
				worstGapMs: this.statWorst,
				bufferWidth: gl.drawingBufferWidth,
				bufferHeight: gl.drawingBufferHeight,
			});
			this.statStart = now;
			this.statFrames = 0;
			this.statCpu = 0;
			this.statWorst = 0;
		}
	}

	private syncEdgePositions(): void {
		const g = this.graph;
		if (!g || !this.edges || !this.layout) return;
		const attr = this.edges.geometry.getAttribute("position") as BufferAttribute;
		const out = attr.array as Float32Array;
		const pos = this.view;
		const ctrl = this.edgeCtrl;
		const surface = this.opts.surface;
		const e = g.edges;
		const m = e.length / 2;
		const pt = this.pt;
		let w = 0;
		for (let k = 0; k < m; k++) {
			const a = e[k * 2] * 3;
			const b = e[k * 2 + 1] * 3;
			const dx = pos[b] - pos[a];
			const dy = pos[b + 1] - pos[a + 1];
			const dz = pos[b + 2] - pos[a + 2];
			const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
			this.edgeLen[k] = len;
			if (!surface) {
				// Nuvem: links curtos retos; quanto mais longo, mais afunda em direção ao centro.
				const x = Math.min(1, Math.max(0, (len - 0.3) / 0.9));
				const bend = 0.7 * x * x * (3 - 2 * x);
				for (let c = 0; c < 3; c++) {
					const mid = (pos[a + c] + pos[b + c]) * 0.5;
					ctrl[k * 3 + c] = mid + (FIBER_CENTER[c] - mid) * bend;
				}
			} else {
				// Arco por fora: o meio da curva fica logo acima da superfície; links longos sobem um pouco mais.
				const mx = (pos[a] + pos[b]) * 0.5;
				const my = (pos[a + 1] + pos[b + 1]) * 0.5;
				const mz = (pos[a + 2] + pos[b + 2]) * 0.5;
				let cx: number, cy: number, cz: number, vx: number, vy: number, vz: number, r: number;
				if (pos[a] * pos[b] >= 0) {
					const h = mx >= 0 ? 1 : -1;
					cx = h * HEMI_CENTER[0];
					cy = HEMI_CENTER[1];
					cz = HEMI_CENTER[2];
					vx = mx - cx;
					vy = my - cy;
					vz = mz - cz;
					const vl = Math.hypot(vx, vy, vz) || 1e-6;
					vx /= vl;
					vy /= vl;
					vz /= vl;
					r = cortexRadius(h, vx, vy, vz) * 1.035 + 0.04 * len;
				} else {
					// Entre hemisférios: passa por cima da fissura longitudinal.
					cx = MIDLINE[0];
					cy = MIDLINE[1];
					cz = MIDLINE[2];
					vx = mx - cx;
					vy = my - cy + 0.5;
					vz = mz - cz;
					const vl = Math.hypot(vx, vy, vz) || 1e-6;
					vx /= vl;
					vy /= vl;
					vz /= vl;
					r = 0.7 + 0.05 * len;
				}
				// Bézier quadrática: ponto do meio = (a + 2c + b) / 4 -> c = 2·alvo − médio.
				ctrl[k * 3] = 2 * (cx + vx * r) - mx;
				ctrl[k * 3 + 1] = 2 * (cy + vy * r) - my;
				ctrl[k * 3 + 2] = 2 * (cz + vz * r) - mz;
			}
			for (let s = 0; s < EDGE_SEGMENTS; s++) {
				this.edgePoint(k, s / EDGE_SEGMENTS, pt);
				out[w++] = pt[0];
				out[w++] = pt[1];
				out[w++] = pt[2];
				this.edgePoint(k, (s + 1) / EDGE_SEGMENTS, pt);
				out[w++] = pt[0];
				out[w++] = pt[1];
				out[w++] = pt[2];
			}
		}
		attr.needsUpdate = true;
		this.writeEdgeColors();
	}

	/** (Re)cria os pulsos ambientes espalhados pelo grafo. */
	private buildAmbient(): void {
		const g = this.graph;
		const m = g ? g.edges.length / 2 : 0;
		this.ambCount = m === 0 ? 0 : Math.min(this.opts.ambientCount, AMBIENT_MAX, m);
		this.ambLast = 0;
		for (let p = 0; p < this.ambCount; p++) {
			this.spawnAmbient(p);
			this.ambT[p] = this.ambRng(); // começam espalhados, não todos juntos
			this.ambAlive[p] = this.opts.ambientPulses ? 1 : 0;
			this.ambGen[p] = 0;
		}
	}

	/** Dispara um pulso de reação em cadeia a partir de `node` pela aresta `e`. */
	private firePulse(node: number, e: number, gen: number): void {
		if (this.ambCount === 0) return;
		const p = this.burstCursor++ % this.ambCount;
		const g = this.graph!;
		this.ambEdge[p] = e;
		this.ambDir[p] = g.edges[e * 2] === node ? 0 : 1;
		this.ambT[p] = 0;
		this.ambSpeed[p] = PULSE_SPEED * 1.6;
		this.ambAlive[p] = 1;
		this.ambGen[p] = gen;
	}

	/** Tela de descanso: de tempos em tempos uma nota bem conectada dispara para os vizinhos. */
	private maybeBurst(dt: number): void {
		this.burstTimer -= dt;
		if (this.burstTimer > 0) return;
		this.burstTimer = BURST_MIN_S + this.ambRng() * (BURST_MAX_S - BURST_MIN_S);
		const g = this.graph;
		if (!g || g.ids.length === 0) return;
		let node = -1;
		for (let tries = 0; tries < 8; tries++) {
			const i = Math.floor(this.ambRng() * g.ids.length);
			if (g.degree[i] >= 2 && (node < 0 || g.degree[i] > g.degree[node])) node = i;
		}
		if (node < 0) return;
		this.flashTarget[node] = 1;
		const opts = g.nodeEdges[node];
		for (let k = 0; k < Math.min(opts.length, 5); k++) this.firePulse(node, opts[k], BURST_GENERATIONS);
	}

	/** Brilho dos neurônios: ataque rápido e suave, decaimento lento. Retorna true se algo ainda brilha. */
	private updateFlash(dt: number): boolean {
		if (!this.nodes || this.flash.length === 0) return false;
		const f = this.flash;
		const target = this.flashTarget;
		const decay = Math.exp(-dt * 1.6);
		const attack = Math.min(1, dt * 10);
		let any = false;
		for (let i = 0; i < f.length; i++) {
			if (target[i] < 0.003 && f[i] < 0.003) continue;
			target[i] *= decay;
			f[i] += (target[i] - f[i]) * attack;
			if (f[i] < 0.003 && target[i] < 0.003) f[i] = target[i] = 0;
			any = true;
		}
		if (any) (this.nodes.geometry.getAttribute("aFlash") as BufferAttribute).needsUpdate = true;
		return any;
	}

	private spawnAmbient(p: number): void {
		const m = this.graph!.edges.length / 2;
		this.ambEdge[p] = Math.floor(this.ambRng() * m);
		this.ambDir[p] = this.ambRng() < 0.5 ? 0 : 1;
		this.ambT[p] = 0;
		this.ambSpeed[p] = PULSE_SPEED * (0.7 + this.ambRng() * 0.6);
	}

	/** Avança os pulsos ambientes. Retorna true se precisa de mais frames. */
	private updateAmbient(now: number): boolean {
		const g = this.graph;
		let alive = 0;
		for (let p = 0; p < this.ambCount; p++) alive += this.ambAlive[p];
		const dt = this.ambLast ? Math.max(0, Math.min(0.05, (now - this.ambLast) / 1000)) : 0;
		this.ambLast = now;
		if (g && this.idleMix > 0.6) this.maybeBurst(dt);
		const flashing = this.updateFlash(dt);
		const active = !!g && this.ambCount > 0 && (this.opts.ambientPulses || alive > 0);
		this.ambient.visible = active;
		if (!active) return flashing;
		const geo = this.ambient.geometry;
		const pArr = (geo.getAttribute("position") as BufferAttribute).array as Float32Array;
		const cArr = (geo.getAttribute("aColor") as BufferAttribute).array as Float32Array;
		const col = this.ambColor;
		const pt = this.pt;
		for (let p = 0; p < this.ambCount; p++) {
			if (!this.ambAlive[p]) {
				const o = p * PULSE_TRAIL * 3;
				cArr.fill(0, o, o + PULSE_TRAIL * 3);
				continue;
			}
			this.ambT[p] += this.ambSpeed[p] * dt;
			if (this.ambT[p] >= 1) {
				const e = this.ambEdge[p];
				const target = g!.edges[e * 2 + (this.ambDir[p] ? 0 : 1)];
				const options = g!.nodeEdges[target];
				const gen = this.ambGen[p];
				// Chegou: o neurônio cintila (forte numa reação em cadeia, de leve num pulso comum).
				this.flashTarget[target] = Math.min(1, this.flashTarget[target] + (gen > 0 ? 0.9 : 0.3));
				if (gen > 1) {
					// Reação em cadeia: repassa para mais um vizinho e este pulso segue por outro (~15 pulsos por reação).
					let fired = 0;
					for (const next of options) {
						if (next === e || fired >= 1) continue;
						this.firePulse(target, next, gen - 1);
						fired++;
					}
				}
				if (gen > 0) this.ambGen[p] = gen - 1;
				if (gen === 1 && !this.opts.ambientPulses) {
					this.ambAlive[p] = 0; // fim da cadeia e pulsos ambientes desligados: some
					continue;
				}
				// Segue para outro link do neurônio de chegada (ou recomeça em outro lugar).
				if (options.length > 1 && this.ambRng() < 0.7) {
					let next = options[Math.floor(this.ambRng() * options.length)];
					if (next === e) next = options[(options.indexOf(e) + 1) % options.length];
					this.ambEdge[p] = next;
					this.ambDir[p] = g!.edges[next * 2] === target ? 0 : 1;
					this.ambT[p] = 0;
				} else if (this.opts.ambientPulses) this.spawnAmbient(p);
				else {
					this.ambAlive[p] = 0;
					continue;
				}
			}
			const e = this.ambEdge[p];
			const dir = this.ambDir[p];
			const head = this.ambT[p];
			col.copy(this.color(g!.group[g!.edges[e * 2 + 1 - dir]])).lerp(WHITE, this.ambGen[p] > 0 ? 0.6 : 0.35);
			if (this.ambGen[p] > 0) col.multiplyScalar(1.5); // reação em cadeia: mais brilhante (aditivo)
			const env = Math.sin(Math.PI * head);
			for (let k = 0; k < PULSE_TRAIL; k++) {
				const o = (p * PULSE_TRAIL + k) * 3;
				const t = head - k * TRAIL_STEP;
				if (t < 0) {
					cArr[o] = cArr[o + 1] = cArr[o + 2] = 0;
					continue;
				}
				const eased = t * t * (3 - 2 * t);
				this.edgePoint(e, dir ? 1 - eased : eased, pt);
				pArr[o] = pt[0];
				pArr[o + 1] = pt[1];
				pArr[o + 2] = pt[2];
				const fade = env * (1 - k / PULSE_TRAIL);
				cArr[o] = col.r * fade;
				cArr[o + 1] = col.g * fade;
				cArr[o + 2] = col.b * fade;
			}
		}
		geo.setDrawRange(0, this.ambCount * PULSE_TRAIL);
		(geo.getAttribute("position") as BufferAttribute).needsUpdate = true;
		(geo.getAttribute("aColor") as BufferAttribute).needsUpdate = true;
		return true;
	}

	/** Prepara um pulso por link da nota sob o mouse (vizinhos mais conectados primeiro). */
	private setupPulses(): void {
		this.pulseCount = 0;
		this.pulseLast = 0;
		const g = this.graph;
		if (!g || this.hover < 0 || !this.opts.hoverPulses) return;
		const h = this.hover;
		const edges = [...g.nodeEdges[h]]
			.sort((a, b) => g.degree[g.edges[b * 2] ^ g.edges[b * 2 + 1] ^ h] - g.degree[g.edges[a * 2] ^ g.edges[a * 2 + 1] ^ h])
			.slice(0, MAX_HOVER_PULSES);
		edges.forEach((e, p) => {
			this.pulseEdge[p] = e;
			this.pulseDir[p] = g.edges[e * 2] === h ? 0 : 1; // sempre saindo da nota sob o mouse
			this.pulseT[p] = (p * 0.37) % 1; // fases espalhadas: não saem todos juntos
		});
		this.pulseCount = edges.length;
		this.pulseColor.copy(this.color(g.group[h])).lerp(WHITE, 0.45);
	}

	/** Avança os pulsos. Retorna true se precisa de mais frames. */
	private updatePulses(now: number): boolean {
		const active = this.pulseCount > 0 && this.hover >= 0 && !this.dragging && this.opts.hoverPulses;
		this.pulses.visible = active;
		if (!active) return false;
		const dt = this.pulseLast ? Math.max(0, Math.min(0.05, (now - this.pulseLast) / 1000)) : 0;
		this.pulseLast = now;
		const geo = this.pulses.geometry;
		const pArr = (geo.getAttribute("position") as BufferAttribute).array as Float32Array;
		const cArr = (geo.getAttribute("aColor") as BufferAttribute).array as Float32Array;
		const col = this.pulseColor;
		const pt = this.pt;
		for (let p = 0; p < this.pulseCount; p++) {
			this.pulseT[p] = (this.pulseT[p] + PULSE_SPEED * dt) % 1;
			const head = this.pulseT[p];
			const env = Math.sin(Math.PI * head); // aparece ao sair, some ao chegar
			for (let k = 0; k < PULSE_TRAIL; k++) {
				const o = (p * PULSE_TRAIL + k) * 3;
				const t = head - k * TRAIL_STEP;
				if (t < 0) {
					cArr[o] = cArr[o + 1] = cArr[o + 2] = 0; // aditivo: cor 0 = invisível
					continue;
				}
				// Easing: acelera ao sair da nota e desacelera ao chegar no vizinho.
				const eased = t * t * (3 - 2 * t);
				this.edgePoint(this.pulseEdge[p], this.pulseDir[p] ? 1 - eased : eased, pt);
				pArr[o] = pt[0];
				pArr[o + 1] = pt[1];
				pArr[o + 2] = pt[2];
				const fade = env * (1 - k / PULSE_TRAIL);
				cArr[o] = col.r * fade;
				cArr[o + 1] = col.g * fade;
				cArr[o + 2] = col.b * fade;
			}
		}
		geo.setDrawRange(0, this.pulseCount * PULSE_TRAIL);
		(geo.getAttribute("position") as BufferAttribute).needsUpdate = true;
		(geo.getAttribute("aColor") as BufferAttribute).needsUpdate = true;
		return true;
	}

	/** Copia o layout para as posições de exibição, aproximando do centro no modo nuvem. */
	private syncView(): void {
		const g = this.graph;
		const layout = this.layout;
		if (!g || !layout || this.view.length !== layout.pos.length) return;
		const src = layout.pos;
		const out = this.view;
		if (this.opts.surface) out.set(src);
		else {
			const [ccx, ccy, ccz] = this.cerebCenter;
			for (let i = 0; i < g.ids.length; i++) {
				const o = i * 3;
				const orphan = g.group[i] < 0;
				const cx = orphan ? ccx : (src[o] >= 0 ? 1 : -1) * HEMI_CENTER[0];
				const cy = orphan ? ccy : HEMI_CENTER[1];
				const cz = orphan ? ccz : HEMI_CENTER[2];
				const k = orphan ? CLOUD_CEREB_SCALE : CLOUD_CORTEX_SCALE;
				out[o] = cx + (src[o] - cx) * k;
				out[o + 1] = cy + (src[o + 1] - cy) * k;
				out[o + 2] = cz + (src[o + 2] - cz) * k;
			}
		}
		if (this.nodes) (this.nodes.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
	}

	private edgePoint(k: number, t: number, out: number[]): void {
		const e = this.graph!.edges;
		const pos = this.view;
		const a = e[k * 2] * 3;
		const b = e[k * 2 + 1] * 3;
		const u = 1 - t;
		for (let c = 0; c < 3; c++) {
			out[c] = u * u * pos[a + c] + 2 * u * t * this.edgeCtrl[k * 3 + c] + t * t * pos[b + c];
		}
	}

	private writeEdgeColors(): void {
		if (!this.edges) return;
		const attr = this.edges.geometry.getAttribute("color") as BufferAttribute;
		const out = attr.array as Float32Array;
		const base = this.edgeBase;
		const m = this.edgeFocus.length;
		let w = 0;
		for (let k = 0; k < m; k++) {
			// Links longos mais discretos; em foco, destacados; fora de foco, quase no fundo.
			const f = this.edgeFocus[k];
			const s = f > 1 ? 1 : f * Math.max(0.35, Math.min(1, 0.35 / (this.edgeLen[k] + 1e-3))) * 0.6;
			for (let v = 0; v < EDGE_SEGMENTS * 2; v++) {
				const t = ((v + 1) >> 1) / EDGE_SEGMENTS;
				out[w++] = BG.r + ((base[k * 6] * (1 - t) + base[k * 6 + 3] * t) - BG.r) * s;
				out[w++] = BG.g + ((base[k * 6 + 1] * (1 - t) + base[k * 6 + 4] * t) - BG.g) * s;
				out[w++] = BG.b + ((base[k * 6 + 2] * (1 - t) + base[k * 6 + 5] * t) - BG.b) * s;
			}
		}
		attr.needsUpdate = true;
	}

	/** Entra suave após ~1,5 s sem interação e sai rápido ao mexer. Retorna true se precisa de mais frames. */
	private updateIdle(now: number): boolean {
		const dt = this.idleLast ? Math.max(0, Math.min(0.05, (now - this.idleLast) / 1000)) : 0;
		this.idleLast = now;
		const resting = !this.dragging && this.hover < 0 && performance.now() - this.lastInteraction > IDLE_DELAY_MS;
		const target = this.opts.idleAnimation && resting ? 1 : 0;
		this.idleMix += (target - this.idleMix) * Math.min(1, dt * (target ? 0.85 : 6));
		if (this.idleMix < 0.001) this.idleMix = 0;
		if (this.idleMix > 0) this.idleTime += dt;
		const breath = this.idleMix * 0.5 * (1 + Math.sin(this.idleTime * 0.9));
		const nowResting = this.idleMix > 0.5;
		if (nowResting !== this.resting) {
			this.resting = nowResting;
			this.callbacks.onRestChange?.(nowResting);
		}
		// Órbita lenta: gira em torno do eixo vertical do cérebro, com um leve sobe e desce.
		if (this.opts.idleOrbit && this.opts.mode === "3d" && this.idleMix > 0 && dt > 0) {
			const cam = this.camera;
			const t = this.controls.target;
			const a = dt * IDLE_ORBIT_SPEED * this.idleMix;
			const ox = cam.position.x - t.x;
			const oz = cam.position.z - t.z;
			cam.position.x = t.x + ox * Math.cos(a) - oz * Math.sin(a);
			cam.position.z = t.z + ox * Math.sin(a) + oz * Math.cos(a);
			cam.position.y += Math.cos(this.idleTime * 0.2) * 0.03 * dt * this.idleMix;
			cam.lookAt(t);
		}
		for (const m of [this.shellMat, this.nodeMat, this.haloMat]) {
			m.uniforms.uTime.value = this.idleTime;
			m.uniforms.uIdle.value = this.idleMix;
		}
		this.haloMat.uniforms.uBreath.value = breath * 0.35;
		this.surfaceMat.uniforms.uRim.value = 1 + breath * 0.3;
		// Precisa de frames enquanto a animação estiver ligada (repouso chega sozinho) ou em transição.
		return this.opts.idleAnimation || this.idleMix > 0;
	}

	private updateUniforms(): void {
		const pr = this.renderer.getPixelRatio();
		const scale =
			this.opts.mode === "3d"
				? this.height / (2 * Math.tan((this.persp.fov * Math.PI) / 360))
				: (this.height * this.ortho.zoom) / (this.ortho.top - this.ortho.bottom);
		// Foco no centro do cérebro: o que está atrás dele vai desfocando até o fundo (~1,1 u depois).
		const focusDist = this.camera.position.distanceTo(this.controls.target);
		// Desfoque começa um pouco antes do centro e chega ao máximo ~0,7 u depois dele.
		const near = focusDist - 0.35;
		const far = focusDist + 0.7;
		const dof = this.opts.dof ? (this.opts.surface && this.opts.showCortex ? 0.5 : 1) : 0;
		for (const m of [this.shellMat, this.nodeMat, this.haloMat, this.pulseMat, this.ambientMat]) {
			m.uniforms.uScale.value = scale;
			m.uniforms.uPixelRatio.value = pr;
			m.uniforms.uDof.value = dof;
			m.uniforms.uDofNear.value = near;
			m.uniforms.uDofFar.value = far;
		}
		this.fog.near = near + 0.1;
		this.fog.far = far + 0.5;
	}

	// ---------- Interação ----------

	private readonly markInteraction = (): void => {
		this.lastInteraction = performance.now();
	};

	private readonly onPointerMove = (evt: PointerEvent): void => {
		this.markInteraction();
		this.mouseX = evt.offsetX;
		this.mouseY = evt.offsetY;
		this.mouseInside = true;
		if (evt.buttons !== 0) return; // arrastando: sem picking
		this.pickDirty = true;
		this.requestFrame();
	};

	private readonly onPointerLeave = (): void => {
		this.mouseInside = false;
		this.pickDirty = true;
		this.requestFrame();
	};

	private readonly onPointerDown = (evt: PointerEvent): void => {
		this.markInteraction();
		this.downX = evt.clientX;
		this.downY = evt.clientY;
	};

	private readonly onPointerUp = (evt: PointerEvent): void => {
		const moved = Math.hypot(evt.clientX - this.downX, evt.clientY - this.downY);
		if (moved < 5 && this.hover >= 0 && evt.button !== 2) this.callbacks.onNodeClick?.(this.hover, evt);
	};

	/**
	 * LOD de interação: com profundidade de campo no modo nuvem, notas no fundo desfocado não
	 * recebem hover nem rótulo (só a metade da frente é interativa).
	 */
	private isFar(i: number): boolean {
		if (!this.opts.dof || (this.opts.surface && this.opts.showCortex)) return false;
		const cam = this.camera.position;
		const o = i * 3;
		const d = Math.hypot(this.view[o] - cam.x, this.view[o + 1] - cam.y, this.view[o + 2] - cam.z);
		return d > cam.distanceTo(this.controls.target) + 0.45;
	}

	/** O nó está no lado do cérebro voltado para a câmera? (Os de trás ficam esmaecidos pela superfície.) */
	private facesCamera(i: number): boolean {
		if (!this.opts.showCortex || !this.opts.surface) return true;
		const pos = this.view;
		const o = i * 3;
		let cx: number, cy: number, cz: number;
		if (this.graph!.group[i] < 0) {
			[cx, cy, cz] = this.cerebCenter;
		} else {
			cx = (pos[o] >= 0 ? 1 : -1) * HEMI_CENTER[0];
			cy = HEMI_CENTER[1];
			cz = HEMI_CENTER[2];
		}
		const cam = this.camera.position;
		return (
			(pos[o] - cx) * (cam.x - pos[o]) + (pos[o + 1] - cy) * (cam.y - pos[o + 1]) + (pos[o + 2] - cz) * (cam.z - pos[o + 2]) >
			0
		);
	}

	private pick(): void {
		this.pickDirty = false;
		let best = -1;
		if (this.mouseInside && this.graph && this.layout) {
			const cam = this.camera;
			cam.updateMatrixWorld();
			this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
			const w = this.width;
			const h = this.height;
			const pos = this.view;
			let bestD = 12 * 12;
			let bestZ = Infinity;
			for (let i = 0; i < this.graph.ids.length; i++) {
				this.tmp.fromArray(pos, i * 3).applyMatrix4(this.viewProj);
				if (this.tmp.z < -1 || this.tmp.z > 1) continue;
				if (!this.facesCamera(i) || this.isFar(i)) continue;
				const dx = (this.tmp.x + 1) * 0.5 * w - this.mouseX;
				const dy = (1 - this.tmp.y) * 0.5 * h - this.mouseY;
				const d = dx * dx + dy * dy;
				if (d < bestD - 4 || (d <= bestD + 4 && this.tmp.z < bestZ)) {
					bestD = Math.min(d, bestD);
					bestZ = this.tmp.z;
					best = i;
				}
			}
		}
		if (best !== this.hover) {
			this.hover = best;
			this.setupPulses();
			this.renderer.domElement.style.cursor = best >= 0 ? "pointer" : "";
			this.refreshFocus();
		}
	}

	private refreshFocus(): void {
		const g = this.graph;
		if (!g || !this.nodes || !this.edges) return;
		const hl = (this.nodes.geometry.getAttribute("aHighlight") as BufferAttribute).array as Float32Array;
		hl.fill(0);
		let focus = 0;
		const labels: { i: number; cls: string }[] = [];

		if (this.hover >= 0) {
			focus = 1;
			hl[this.hover] = 1;
			const nb = [...g.neighbors[this.hover]].sort((a, b) => g.degree[b] - g.degree[a]);
			for (const j of nb) hl[j] = 0.7;
			labels.push({ i: this.hover, cls: "is-hover" });
			for (const j of nb.slice(0, 25)) labels.push({ i: j, cls: "" });
		} else if (this.search.length) {
			focus = 1;
			for (const i of this.search) hl[i] = 1;
			for (const i of this.search.slice(0, 30)) labels.push({ i, cls: "" });
		} else if (this.opts.hubLabels) {
			for (const i of this.hubs) labels.push({ i, cls: "is-hub" });
		}
		if (this.active >= 0 && this.active < hl.length) {
			hl[this.active] = 1;
			if (!labels.some((l) => l.i === this.active)) labels.push({ i: this.active, cls: "is-active" });
		}
		(this.nodes.geometry.getAttribute("aHighlight") as BufferAttribute).needsUpdate = true;
		this.nodeMat.uniforms.uFocus.value = focus;
		this.haloMat.uniforms.uFocus.value = focus;
		this.ambientMat.uniforms.uIntensity.value = focus ? AMBIENT_INTENSITY * 0.25 : AMBIENT_INTENSITY;
		this.labelSet = labels;

		const e = g.edges;
		for (let k = 0; k < e.length / 2; k++) {
			let s = 1;
			if (focus && this.hover >= 0) s = e[k * 2] === this.hover || e[k * 2 + 1] === this.hover ? 2 : 0.12;
			else if (focus) s = hl[e[k * 2]] > 0.5 && hl[e[k * 2 + 1]] > 0.5 ? 2 : 0.12;
			this.edgeFocus[k] = s;
		}
		this.writeEdgeColors();
	}

	private updateLabels(): void {
		const g = this.graph;
		const set = this.labelSet;
		while (this.labelPool.length < set.length) {
			const el = document.createElement("div");
			el.className = "brain-graph-label";
			this.labelLayer.appendChild(el);
			this.labelPool.push(el);
		}
		if (!g || !this.layout) return;
		const cam = this.camera;
		for (let k = 0; k < this.labelPool.length; k++) {
			const el = this.labelPool[k];
			const item = set[k];
			if (!item) {
				if (el.style.display !== "none") el.style.display = "none";
				continue;
			}
			this.tmp.fromArray(this.view, item.i * 3).project(cam);
			if (this.tmp.z > 1 || (item.cls !== "is-active" && (!this.facesCamera(item.i) || this.isFar(item.i)))) {
				el.style.display = "none";
				continue;
			}
			el.style.display = "";
			const text = g.names[item.i];
			if (el.textContent !== text) el.textContent = text;
			const cls = "brain-graph-label " + item.cls;
			if (el.className !== cls) el.className = cls;
			const x = (this.tmp.x + 1) * 0.5 * this.width;
			const y = (1 - this.tmp.y) * 0.5 * this.height;
			el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -150%)`;
		}
	}
}

const WHITE = new Color(1, 1, 1);
