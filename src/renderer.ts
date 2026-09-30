import {
	BufferAttribute,
	BufferGeometry,
	Color,
	LineBasicMaterial,
	LineSegments,
	Matrix4,
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
import { mulberry32, sampleShell } from "./brain-shape";
import type { GraphCore } from "./graph-core";
import { BrainLayout, type SavedPosition } from "./layout";

export type ViewMode = "3d" | "2d";
export type ViewPreset = "lateral" | "superior" | "frontal";

export interface RenderOptions {
	mode: ViewMode;
	showCortex: boolean;
	nodeSize: number;
	hubLabels: boolean;
}

export interface RendererCallbacks {
	onNodeClick?: (index: number, evt: MouseEvent) => void;
	/** Medidor de desempenho: chamado ~2x por segundo enquanto há frames sendo desenhados. */
	onStats?: (stats: FrameStats) => void;
	/** O layout terminou de se acomodar (`moved` = false se tudo veio pronto do cache). */
	onLayoutSettled?: (moved: boolean) => void;
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

const TARGET = new Vector3(0, -0.14, 0);
const PRESETS: Record<ViewPreset, [number, number, number]> = {
	lateral: [1, 0.08, 0.02],
	superior: [0, 1, -0.01],
	frontal: [0.02, 0.08, 1],
};
const CAMERA_DISTANCE = 3.6;
const ORTHO_HALF_HEIGHT = 1.2;
const BG = new Color("#070a12");
const PALETTE = [
	"#5eead4", "#a78bfa", "#f472b6", "#60a5fa", "#fbbf24", "#34d399",
	"#fb7185", "#38bdf8", "#c084fc", "#f59e0b", "#4ade80", "#e879f9",
];
const ORPHAN_COLOR = new Color("#8391b0");
/** Segmentos por aresta: links longos curvam para o centro (substância branca). */
const EDGE_SEGMENTS = 4;
const FIBER_CENTER = [0, 0.05, -0.1];

/** Teto de pixels do framebuffer (~1080p). Acima disso o custo de fill cresce sem ganho visível. */
const PIXEL_BUDGET = 1.6e6;
const MAX_POINT_PX = 28;
/** Meta: nunca abaixo de 20 fps. O governador reduz a resolução se o frame passar disso. */
const SLOW_FRAME_MS = 50;

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aHighlight;
uniform float uScale;
uniform float uPixelRatio;
uniform float uOrtho;
uniform float uFocus;
uniform float uMinSize;
uniform float uMaxSize;
uniform vec3 uBg;
varying vec3 vColor;
void main() {
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mv;
	float px = uOrtho > 0.5 ? aSize * uScale : aSize * uScale / max(-mv.z, 0.001);
	px *= 1.0 + aHighlight * 0.5;
	gl_PointSize = clamp(px, uMinSize, uMaxSize) * uPixelRatio;
	float dim = uFocus * (1.0 - step(0.5, aHighlight));
	vColor = mix(aColor, uBg, dim * 0.8);
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
	vec2 c = gl_PointCoord - 0.5;
	float r2 = dot(c, c);
	if (r2 > 0.25) discard;
	gl_FragColor = vec4(r2 > 0.14 ? vColor * 0.6 : vColor, 1.0);
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
			uBg: { value: BG },
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		depthWrite,
	});
}

function pointGeometry(positions: Float32Array, colors: Float32Array, size: Float32Array): BufferGeometry {
	const geo = new BufferGeometry();
	geo.setAttribute("position", new BufferAttribute(positions, 3));
	geo.setAttribute("aColor", new BufferAttribute(colors, 3));
	geo.setAttribute("aSize", new BufferAttribute(size, 1));
	geo.setAttribute("aHighlight", new BufferAttribute(new Float32Array(positions.length / 3), 1));
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
	private readonly shellMat = pointMaterial(1, false);
	private readonly nodeMat = pointMaterial(2.5, true);
	private readonly edgeMat = new LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity: 0.55,
		depthWrite: false,
	});

	private graph?: GraphCore;
	private layout?: BrainLayout;
	private nodes?: Points;
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
		this.scene.add(this.shell);

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
		this.opts = { ...this.opts, ...partial };
		if (modeChanged) {
			const dir = this.camera.position.clone().sub(this.controls.target).normalize();
			this.setupControls();
			this.placeCamera(dir);
		}
		if (sizeChanged) this.buildNodes();
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
		for (const obj of [this.shell, this.nodes, this.edges]) obj?.geometry.dispose();
		for (const m of [this.shellMat, this.nodeMat, this.edgeMat]) m.dispose();
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
		const ortho = this.opts.mode === "2d" ? 1 : 0;
		this.shellMat.uniforms.uOrtho.value = ortho;
		this.nodeMat.uniforms.uOrtho.value = ortho;
	}

	private buildNodes(): void {
		const g = this.graph;
		const layout = this.layout;
		if (!g || !layout) return;
		if (this.nodes) {
			this.scene.remove(this.nodes);
			this.nodes.geometry.dispose();
		}
		const n = g.ids.length;
		const colors = new Float32Array(n * 3);
		const sizes = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			this.color(g.group[i]).toArray(colors, i * 3);
			sizes[i] = Math.min(0.09, 0.018 * this.opts.nodeSize * (0.8 + 0.4 * Math.sqrt(g.degree[i])));
		}
		this.nodes = new Points(pointGeometry(layout.pos, colors, sizes), this.nodeMat);
		this.nodes.frustumCulled = false;
		this.nodes.renderOrder = 1;
		this.scene.add(this.nodes);
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

	private readonly requestFrame = (): void => {
		if (this.disposed || this.raf) return;
		this.raf = requestAnimationFrame(this.frame);
	};

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
			(this.nodes!.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
			this.syncEdgePositions();
			if (!this.layout.running) this.callbacks.onLayoutSettled?.(true);
		}

		if (this.pickDirty && !this.dragging) this.pick();
		this.updateUniforms();
		this.renderer.render(this.scene, this.camera);
		this.updateLabels();

		if (keepGoing) this.requestFrame();
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
		const pos = this.layout.pos;
		const ctrl = this.edgeCtrl;
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
			// Links curtos ficam retos; quanto mais longo, mais ele afunda em direção ao centro.
			const x = Math.min(1, Math.max(0, (len - 0.3) / 0.9));
			const bend = 0.7 * x * x * (3 - 2 * x);
			for (let c = 0; c < 3; c++) {
				const mid = (pos[a + c] + pos[b + c]) * 0.5;
				ctrl[k * 3 + c] = mid + (FIBER_CENTER[c] - mid) * bend;
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

	private edgePoint(k: number, t: number, out: number[]): void {
		const e = this.graph!.edges;
		const pos = this.layout!.pos;
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

	private updateUniforms(): void {
		const pr = this.renderer.getPixelRatio();
		const scale =
			this.opts.mode === "3d"
				? this.height / (2 * Math.tan((this.persp.fov * Math.PI) / 360))
				: (this.height * this.ortho.zoom) / (this.ortho.top - this.ortho.bottom);
		for (const m of [this.shellMat, this.nodeMat]) {
			m.uniforms.uScale.value = scale;
			m.uniforms.uPixelRatio.value = pr;
		}
	}

	// ---------- Interação ----------

	private readonly onPointerMove = (evt: PointerEvent): void => {
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
		this.downX = evt.clientX;
		this.downY = evt.clientY;
	};

	private readonly onPointerUp = (evt: PointerEvent): void => {
		const moved = Math.hypot(evt.clientX - this.downX, evt.clientY - this.downY);
		if (moved < 5 && this.hover >= 0 && evt.button !== 2) this.callbacks.onNodeClick?.(this.hover, evt);
	};

	private pick(): void {
		this.pickDirty = false;
		let best = -1;
		if (this.mouseInside && this.graph && this.layout) {
			const cam = this.camera;
			cam.updateMatrixWorld();
			this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
			const w = this.width;
			const h = this.height;
			const pos = this.layout.pos;
			let bestD = 12 * 12;
			let bestZ = Infinity;
			for (let i = 0; i < this.graph.ids.length; i++) {
				this.tmp.fromArray(pos, i * 3).applyMatrix4(this.viewProj);
				if (this.tmp.z < -1 || this.tmp.z > 1) continue;
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
			this.tmp.fromArray(this.layout.pos, item.i * 3).project(cam);
			if (this.tmp.z > 1) {
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
